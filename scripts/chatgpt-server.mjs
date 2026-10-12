import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createChatGPTAuth } from "./chatgpt-auth.mjs";
import { readSse, validateBridgeRequest } from "../extension/bridge.js";
import { buildPayload, TranslationStream, validateResponse } from "../extension/translation-protocol.js";

const fail = () => { throw new Error("invalid_response"); };

export function responsesPayload(payload, model) {
  if (!validateBridgeRequest({ type: "translate", jobId: "companion", payload })) fail();
  const text = payload.messages[1].content;
  if (!["ja", "en"].some((language) =>
    payload.messages[0].content === buildPayload(text, language).messages[0].content)) fail();
  return { model, instructions: payload.messages[0].content,
    input: [{ role: "user", content: text }], store: false, stream: true };
}

export async function convertResponses(body, emit, signal) {
  const stream = new TranslationStream();
  let completed = false;
  let itemId = null;
  let outputIndex = null;
  let completedMessage = null;
  let usage;

  function validateMessage(message, index) {
    if (message?.type !== "message" || message.role !== "assistant" || message.status !== "completed" ||
        itemId === null || message.id !== itemId || index !== outputIndex ||
        !Array.isArray(message.content) || message.content.length !== 1 ||
        message.content[0].type !== "output_text" || message.content[0].text !== stream.text) fail();
  }

  await readSse(body, (event) => {
    if (event?.type === "response.output_text.delta") {
      if (typeof event.delta !== "string" || typeof event.item_id !== "string" ||
          !Number.isInteger(event.output_index) || event.output_index < 0 || event.content_index !== 0) fail();
      itemId ??= event.item_id;
      outputIndex ??= event.output_index;
      if (itemId !== event.item_id || outputIndex !== event.output_index) fail();
      const chunk = { choices: [{ delta: { content: event.delta }, finish_reason: null }] };
      stream.push(chunk);
      emit(chunk);
    } else if (event?.type === "response.output_item.added") {
      if (!["message", "reasoning"].includes(event.item?.type)) fail();
    } else if (event?.type === "response.output_item.done") {
      if (event.item?.type !== "reasoning") {
        if (completedMessage !== null) fail();
        validateMessage(event.item, event.output_index);
        completedMessage = event.item;
      }
    } else if (["error", "response.failed", "response.incomplete", "response.refusal.delta", "response.refusal.done"].includes(event?.type)) {
      fail();
    } else if (event?.type === "response.completed") {
      const response = event.response;
      if (response?.status !== "completed" || !Array.isArray(response.output)) fail();
      const messages = response.output.filter((item) => item.type !== "reasoning");
      // Plan-usage streams can omit terminal output after sending output_item.done.
      if (response.output.length === 0) {
        if (completedMessage === null) fail();
        validateMessage(completedMessage, outputIndex);
      } else {
        if (messages.length !== 1 || response.output[outputIndex] !== messages[0]) fail();
        validateMessage(messages[0], outputIndex);
      }
      usage = response.usage;
      stream.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
      stream.push({ choices: [], usage });
      validateResponse(stream.response());
      completed = true;
      return true;
    } else if (typeof event?.type !== "string" || !event.type.startsWith("response.")) {
      fail();
    }
  }, signal);
  if (!completed) fail();
  emit({ choices: [{ delta: {}, finish_reason: "stop" }] });
  emit({ choices: [], usage: { total_tokens: usage.total_tokens } });
}

async function requestBody(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") fail();
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) fail();
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

export function createChatGPTServer({ origin, auth, fetchImpl = globalThis.fetch }) {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new Error("invalid_origin");
  const server = createServer((request, response) => {
    void handle(request, response).catch((value) => {
      if (response.headersSent) response.destroy();
      else json(response, value.message === "chatgpt_auth_required" ? 401 : 502, { error: "chatgpt_unavailable" });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  async function handle(request, response) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const host = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== host) return json(response, 403, { error: "forbidden" });
    const url = new URL(request.url, `http://${host}`);
    if (url.origin !== `http://${host}`) return json(response, 403, { error: "forbidden" });
    const browserOrigin = request.headers.origin;
    if (browserOrigin !== undefined && browserOrigin !== origin) return json(response, 403, { error: "forbidden" });
    if (browserOrigin === origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    const runtime = await auth;
    if (request.method === "GET" && url.pathname === "/auth/login") {
      try {
        response.writeHead(302, { Location: runtime.login(url.searchParams) });
        response.end();
      } catch { json(response, 400, { error: "invalid_state" }); }
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/callback") {
      let message;
      let status = 200;
      try {
        await runtime.callback(url.searchParams);
        message = "ChatGPT に接続しました。拡張のポップアップを開き直し、有効を ON にしてください。";
      } catch {
        status = 400;
        message = "ChatGPT の接続を完了できませんでした。拡張から再接続し、利用枠の使用を許可してください。";
      }
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(message);
      return;
    }
    const routes = { "/status": "GET", "/auth/start": "POST", "/auth/logout": "POST", "/v1/chat/completions": "POST" };
    if (!Object.hasOwn(routes, url.pathname) || url.search || request.method !== routes[url.pathname] && request.method !== "OPTIONS") {
      return json(response, 404, { error: "not_found" });
    }
    if (request.method === "OPTIONS") {
      const headers = request.headers["access-control-request-headers"]?.toLowerCase().split(",").map((value) => value.trim()) ?? [];
      if (browserOrigin !== origin || request.headers["access-control-request-method"] !== routes[url.pathname] ||
          !headers.includes("x-discord-translate") || headers.some((value) => !["x-discord-translate", "content-type"].includes(value))) {
        return json(response, 403, { error: "forbidden" });
      }
      response.writeHead(204, { "Access-Control-Allow-Methods": routes[url.pathname],
        "Access-Control-Allow-Headers": "X-Discord-Translate, Content-Type" });
      response.end();
      return;
    }
    if (request.headers["x-discord-translate"] !== "1") return json(response, 403, { error: "forbidden" });
    if (url.pathname === "/status") return json(response, 200, await runtime.status());
    if (url.pathname === "/auth/start") return json(response, 200, await runtime.start());
    if (url.pathname === "/auth/logout") return json(response, 200, await runtime.logout());

    let payload;
    try {
      payload = await requestBody(request);
      responsesPayload(payload, "validation");
    } catch { return json(response, 400, { error: "invalid_input" }); }
    const controller = new AbortController();
    runtime.activeRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 120_000);
    response.on("close", () => controller.abort());
    try {
      const tokens = await runtime.access();
      controller.signal.throwIfAborted();
      const upstream = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.accessToken}` },
        body: JSON.stringify(responsesPayload(payload, tokens.model)),
        redirect: "error", signal: controller.signal,
      });
      if (upstream.status !== 200) {
        await upstream.body?.cancel();
        return json(response, [401, 403, 429].includes(upstream.status) ? upstream.status : 502, { error: "chatgpt_unavailable" });
      }
      const contentType = upstream.headers.get("content-type");
      // Some plan-usage responses omit this header; the SSE and completion still must validate.
      if (contentType !== null && contentType.split(";")[0].trim().toLowerCase() !== "text/event-stream") fail();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      await convertResponses(upstream.body, (chunk) => {
        controller.signal.throwIfAborted();
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }, controller.signal);
      response.end("data: [DONE]\n\n");
    } finally {
      controller.abort();
      clearTimeout(timeout);
      runtime.activeRequests.delete(controller);
    }
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let server;
  try {
    let ready;
    const auth = new Promise((resolve) => { ready = resolve; });
    server = createChatGPTServer({ origin: process.env.CORS_ORIGIN, auth });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(8766, "127.0.0.1", resolve); });
    // Bind before touching credentials so a second process cannot race refresh/storage.
    const runtime = await createChatGPTAuth();
    ready(runtime);
    console.log("ChatGPT translation helper: 127.0.0.1:8766");
    const stop = () => {
      for (const controller of runtime.activeRequests) controller.abort();
      server.close();
      server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch {
    server?.close();
    server?.closeAllConnections();
    console.error("chatgpt_helper_start_failed: CORS_ORIGIN、ポート8766、認証ファイルを確認してください。");
    process.exitCode = 1;
  }
}
