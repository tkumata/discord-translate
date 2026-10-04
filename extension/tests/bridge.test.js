import test from "node:test";
import assert from "node:assert/strict";
import {
  API_URL,
  FETCH_TIMEOUT_MS,
  handleBridgeRequest,
  readSse,
  connectBridge,
  validateBridgeRequest,
} from "../bridge.js";
import { buildPayload } from "../service-worker.js";

function port() {
  return {
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
}

function timers() {
  let current;
  return {
    setTimeout(callback, ms) {
      current = { callback, ms, active: true };
      return current;
    },
    clearTimeout(timer) {
      if (timer === current) timer.active = false;
    },
    get current() {
      return current;
    },
  };
}

function diagnosticsLogger() {
  const calls = [];
  return {
    calls,
    logger: { warn(...args) { calls.push(args); } },
  };
}

test("accepts only the service worker's fixed translation envelope", () => {
  const valid = { type: "translate", jobId: "job-1", payload: buildPayload("source") };
  assert.equal(validateBridgeRequest(valid), true);
  assert.equal(validateBridgeRequest({
    ...valid,
    payload: { ...valid.payload, max_tokens: 512 },
  }), false);
  assert.equal(validateBridgeRequest({ ...valid, url: API_URL }), false);
  assert.equal(validateBridgeRequest({ ...valid, payload: { ...valid.payload, method: "GET" } }), false);
  assert.equal(validateBridgeRequest({ ...valid, payload: { ...valid.payload, headers: {} } }), false);
  assert.equal(validateBridgeRequest({ ...valid, payload: { ...valid.payload, stream: false } }), false);
  assert.equal(validateBridgeRequest({ ...valid, payload: { ...valid.payload, stream_options: {} } }), false);
});

function sseResponse(text) {
  return new Response(text, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

test("posts only to the fixed localhost endpoint and sends chunks before the end", async () => {
  const target = port();
  const pending = new Map();
  const timer = timers();
  const message = { type: "translate", jobId: "job-2", payload: buildPayload("source") };
  await handleBridgeRequest(target, message, pending, {
    setTimeoutImpl: timer.setTimeout,
    clearTimeoutImpl: timer.clearTimeout,
    fetchImpl: async (url, options) => {
      assert.equal(url, API_URL);
      assert.equal(options.method, "POST");
      assert.deepEqual(options.headers, { "Content-Type": "application/json" });
      assert.deepEqual(JSON.parse(options.body), message.payload);
      return sseResponse('data: {"choices":[]}\n\ndata: [DONE]\n\n');
    },
  });
  assert.deepEqual(target.messages, [
    { type: "chunk", jobId: "job-2", payload: { choices: [] } },
    { type: "end", jobId: "job-2" },
  ]);
  assert.equal(pending.size, 0);
  assert.equal(timer.current.ms, FETCH_TIMEOUT_MS);
  assert.equal(timer.current.active, false);
});

test("uses the same 120-second execution timeout as the service worker", () => {
  assert.equal(FETCH_TIMEOUT_MS, 120_000);
});

test("returns fixed error envelopes for timeout, local-network denial, and HTTP failure", async () => {
  const message = { type: "translate", jobId: "job-3", payload: buildPayload("source") };
  const timeoutTimer = timers();
  const timeoutTarget = port();
  const timeoutRequest = handleBridgeRequest(timeoutTarget, message, new Map(), {
    setTimeoutImpl: timeoutTimer.setTimeout,
    clearTimeoutImpl: timeoutTimer.clearTimeout,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  timeoutTimer.current.callback();
  await timeoutRequest;
  assert.deepEqual(timeoutTarget.messages, [
    { type: "error", jobId: "job-3", error: "request_timeout" },
  ]);

  const deniedTarget = port();
  await handleBridgeRequest(deniedTarget, message, new Map(), {
    fetchImpl: async () => { throw Object.assign(new Error(), { name: "NotAllowedError" }); },
  });
  assert.deepEqual(deniedTarget.messages, [
    { type: "error", jobId: "job-3", error: "lna_denied" },
  ]);

  const httpTarget = port();
  await handleBridgeRequest(httpTarget, message, new Map(), {
    fetchImpl: async () => ({ status: 503 }),
  });
  assert.deepEqual(httpTarget.messages, [
    { type: "result", jobId: "job-3", status: 503 },
  ]);
});

test("logs only unavailable diagnostics when bridge JSON parsing fails", async () => {
  const target = port();
  const capture = diagnosticsLogger();
  const message = { type: "translate", jobId: "job-privacy", payload: buildPayload("秘密の入力") };
  await handleBridgeRequest(target, message, new Map(), {
    logger: capture.logger,
    fetchImpl: async () => sseResponse('data: 秘密の例外\n\n'),
  });
  assert.deepEqual(target.messages, [
    { type: "error", jobId: "job-privacy", error: "invalid_response" },
  ]);
  assert.deepEqual(capture.calls, [["invalid_response", {
    finish_reason: null,
    content_present: false,
    reasoning_present: false,
    usage_total_tokens_present: false,
  }]]);
  assert.equal(JSON.stringify(capture.calls).includes("秘密"), false);
  assert.equal(JSON.stringify(capture.calls).includes("job-privacy"), false);
});

test("SSE handles split UTF-8, CR/LF boundaries, multiline data, comments and usage", async () => {
  const bytes = new TextEncoder().encode(': keepalive\r\nid: 1\r\nretry: 10\r\n\r\n' +
    'data: {"choices":\r\ndata: [{"delta":{"content":"訳🚀"}}]}\r\n\r\n' +
    'data: {"choices":[],"usage":{"total_tokens":2}}\r\rdata: [DONE]\n\n');
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); },
    cancel() { cancelled = true; },
  });
  const events = [];
  await readSse(body, (event) => events.push(event));
  assert.deepEqual(events, [
    { choices: [{ delta: { content: "訳🚀" } }] },
    { choices: [], usage: { total_tokens: 2 } },
  ]);
  assert.equal(cancelled, true);
});

test("rejects missing terminal event, invalid UTF-8, content type and oversized pending data", async () => {
  for (const response of [
    sseResponse('data: {}\n\n'),
    sseResponse('data: ' + 'x'.repeat(1024 * 1024 + 1)),
    sseResponse(Uint8Array.of(0xff)),
    new Response('{}', { headers: { "Content-Type": "application/json" } }),
  ]) {
    const target = port();
    await handleBridgeRequest(target, { type: "translate", jobId: "bad", payload: buildPayload("source") }, new Map(), {
      logger: { warn() {} }, fetchImpl: async () => response,
    });
    assert.deepEqual(target.messages.at(-1), { type: "error", jobId: "bad", error: "invalid_response" });
    assert.equal(target.messages.some((message) => message.type === "end"), false);
  }
});

test("known abort cancels a pending reader while malformed and unknown aborts have no effect", async () => {
  const pending = new Map();
  const target = port();
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const request = handleBridgeRequest(target, { type: "translate", jobId: "active", payload: buildPayload("source") }, pending, {
    fetchImpl: async () => sseResponse(body),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await handleBridgeRequest(target, { type: "abort", jobId: "other" }, pending);
  await handleBridgeRequest(target, { type: "abort", jobId: "active", extra: true }, pending);
  assert.equal(cancelled, false);
  await handleBridgeRequest(target, { type: "abort", jobId: "active" }, pending);
  await request;
  assert.equal(cancelled, true);
  assert.equal(pending.size, 0);
  assert.deepEqual(target.messages, []);
});

test("reader network failures remain network errors without private diagnostics", async () => {
  const target = port();
  const capture = diagnosticsLogger();
  const body = new ReadableStream({ start(controller) { controller.error(new TypeError("private network detail")); } });
  await handleBridgeRequest(target, { type: "translate", jobId: "network", payload: buildPayload("source") }, new Map(), {
    logger: capture.logger, fetchImpl: async () => sseResponse(body),
  });
  assert.deepEqual(target.messages, [{ type: "error", jobId: "network", error: "network_error" }]);
  assert.deepEqual(capture.calls, []);
});

test("bridge disconnect cancels active readers and reconnects without restarting their jobs", async () => {
  let cancelled = false;
  let connections = 0;
  const messages = [];
  const disconnects = [];
  const target = { ...port(),
    onMessage: { addListener(listener) { messages.push(listener); } },
    onDisconnect: { addListener(listener) { disconnects.push(listener); } },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(new ReadableStream({ cancel() { cancelled = true; } }));
  try {
    connectBridge({ runtime: { connect() { connections++; return target; } } });
    messages[0]({ type: "translate", jobId: "active", payload: buildPayload("source") });
    await new Promise((resolve) => setImmediate(resolve));
    disconnects[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.equal(connections, 2);
    assert.deepEqual(target.messages, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
