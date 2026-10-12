import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createChatGPTAuth, verifyIdentity } from "../chatgpt-auth.mjs";
import { createChatGPTServer, convertResponses, responsesPayload } from "../chatgpt-server.mjs";
import { buildPayload, TranslationStream, validateResponse } from "../../extension/translation-protocol.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" }] };
const config = { issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
  token_endpoint: "https://auth.openai.com/api/accounts/oauth/token", jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
  revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" };
const planScope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function idToken(now, nonce, changes = {}, headerChanges = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test", ...headerChanges })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: config.issuer, aud: "oaiapp_test", sub: "test-subject",
    email: "test@example.invalid", iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600,
    nonce, ...changes })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url")}`;
}

async function authFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "discord-chatgpt-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = { directory, now: 1_000_000, calls: [], refreshCalls: 0, nonce: null,
    scopes: planScope, revokeStatus: 200, modelStatus: 200, tokenGate: null };
  fixture.fetchImpl = async (url, options = {}) => {
    fixture.calls.push({ url, options });
    if (url.endsWith("openid-configuration")) return json(config);
    if (url === config.jwks_uri) return json(jwks);
    if (url.endsWith("/models")) return json({ models: [{ slug: "hidden", visibility: "hidden" },
      { slug: "available-model", visibility: "list" }] }, fixture.modelStatus);
    if (url === config.revocation_endpoint) return new Response(null, { status: fixture.revokeStatus });
    assert.equal(url, config.token_endpoint);
    const refreshing = options.body.get("grant_type") === "refresh_token";
    if (refreshing) fixture.refreshCalls++;
    if (fixture.tokenGate) { fixture.tokenGate.started.resolve(); await fixture.tokenGate.release.promise; }
    return json({ access_token: refreshing ? "refreshed-access" : "initial-access",
      refresh_token: refreshing ? "rotated-refresh" : "initial-refresh", token_type: "Bearer", expires_in: 3600,
      scope: fixture.scopes, id_token: idToken(fixture.now, fixture.nonce) });
  };
  fixture.create = () => createChatGPTAuth({ directory, fetchImpl: fixture.fetchImpl, now: () => fixture.now });
  fixture.auth = await fixture.create();
  fixture.attempt = async () => {
    const result = await fixture.auth.start();
    const login = new URL(result.url);
    const authorize = new URL(fixture.auth.login(login.searchParams));
    fixture.nonce = authorize.searchParams.get("nonce");
    return { authorize, parameters: new URLSearchParams({ state: login.searchParams.get("state"),
      code: "test-code", client_id: "oaiapp_test" }) };
  };
  fixture.connect = async () => {
    const { parameters } = await fixture.attempt();
    await fixture.auth.callback(parameters);
  };
  fixture.saved = async () => JSON.parse(await readFile(join(directory, "chatgpt.json"), "utf8"));
  return fixture;
}

test("ID tokens require a trusted signature, algorithm, key and matching identity claims", () => {
  const expected = { clientId: "oaiapp_test", nonce: "nonce", now: 1_000_000 };
  assert.equal(verifyIdentity(idToken(expected.now, "nonce"), jwks, expected).sub, "test-subject");
  for (const changes of [{ iss: "https://example.invalid" }, { aud: "other" }, { exp: 999 },
    { iat: 2000 }, { nbf: 2000 }, { sub: "" }, { nonce: "other" }, { aud: ["oaiapp_test", "other"] }]) {
    assert.throws(() => verifyIdentity(idToken(expected.now, "nonce", changes), jwks, expected));
  }
  for (const header of [{ alg: "none" }, { alg: "HS256" }, { alg: "ES256" }, { kid: "unknown" }, { crit: ["unknown"] }]) {
    assert.throws(() => verifyIdentity(idToken(expected.now, "nonce", {}, header), jwks, expected));
  }
  const token = idToken(expected.now, "nonce");
  assert.throws(() => verifyIdentity(`${token.slice(0, -8)}AAAAAAAA`, jwks, expected));
});

test("OAuth connects with PKCE, validates one-time callback, persists protected tokens and reuses registration", async (t) => {
  const f = await authFixture(t);
  const { authorize, parameters } = await f.attempt();
  assert.equal(authorize.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("redirect_uri"), "http://127.0.0.1:8766/auth/callback");
  assert.equal(authorize.searchParams.get("resource"), "https://api.openai.com/v1");
  await assert.rejects(f.auth.callback(new URLSearchParams({ state: "wrong", code: "code" })));
  await f.auth.callback(parameters);
  await assert.rejects(f.auth.callback(parameters));
  assert.deepEqual(await f.auth.status(), { connected: true, account: "test@example.invalid", model: "available-model" });
  const saved = await f.saved();
  assert.equal((await stat(join(f.directory, "chatgpt.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  const restarted = await f.create();
  assert.equal((await restarted.status()).connected, true);
  assert.deepEqual(await f.auth.logout(), { connected: false, revoked: true });
  assert.equal((await f.saved()).tokens, null);
  const next = await f.attempt();
  assert.equal(next.authorize.searchParams.get("client_id"), "oaiapp_test");
  assert.equal(next.authorize.searchParams.has("agent_name_hint"), false);
  assert.equal(next.authorize.searchParams.get("ext_agent_host_id"), saved.hostId);
  next.parameters.set("client_id", "oaiapp_other");
  await assert.rejects(f.auth.callback(next.parameters));
  assert.equal((await f.auth.status()).connected, false);
  const exchange = f.calls.find((call) => call.url === config.token_endpoint);
  assert.equal(exchange.options.body.get("client_id"), "oaiapp_test");
  assert.ok(exchange.options.body.get("code_verifier"));
  assert.equal(exchange.options.body.has("client_secret"), false);
});

test("denied plan scopes and expired/denied callbacks never save credentials", async (t) => {
  const f = await authFixture(t);
  let attempt = await f.attempt();
  f.scopes = "openid email";
  await assert.rejects(f.auth.callback(attempt.parameters));
  assert.equal((await f.saved()).tokens, null);
  attempt = await f.attempt();
  f.now += 10 * 60_000;
  await assert.rejects(f.auth.callback(attempt.parameters));
  attempt = await f.attempt();
  attempt.parameters.set("error", "access_denied");
  await assert.rejects(f.auth.callback(attempt.parameters));
  assert.equal((await f.saved()).tokens, null);
});

test("refresh is shared, stores the rotating token and keeps the model selected at login", async (t) => {
  const f = await authFixture(t);
  await f.connect();
  f.modelStatus = 503;
  f.now += 3600_000;
  const [first, second] = await Promise.all([f.auth.access(), f.auth.access()]);
  assert.equal(f.refreshCalls, 1);
  assert.equal(first.accessToken, "refreshed-access");
  assert.deepEqual(first, second);
  assert.equal((await f.saved()).tokens.refreshToken, "rotated-refresh");
  assert.equal(first.model, "available-model");
  assert.equal(f.calls.filter((call) => call.url.endsWith("/models")).length, 1);
  assert.equal((await (await f.create()).status()).connected, true);
});

test("a new login cannot cancel logout's credential erasure or revocation", async (t) => {
  const f = await authFixture(t);
  await f.connect();
  const logout = f.auth.logout();
  const next = await f.attempt();
  assert.deepEqual(await logout, { connected: false, revoked: true });
  assert.equal((await f.saved()).tokens, null);
  assert.equal((await (await f.create()).status()).connected, false);
  assert.equal(f.calls.filter((call) => call.url === config.revocation_endpoint).length, 1);
  await f.auth.callback(next.parameters);
  assert.equal((await f.auth.status()).connected, true);
  assert.equal((await f.saved()).tokens.accessToken, "initial-access");
});

test("logout invalidates delayed callback and refresh, aborts requests, and reports unconfirmed revocation", async (t) => {
  for (const operation of ["callback", "refresh"]) {
    const f = await authFixture(t);
    let parameters;
    if (operation === "refresh") { await f.connect(); f.now += 3600_000; }
    else ({ parameters } = await f.attempt());
    const controller = new AbortController();
    f.auth.activeRequests.add(controller);
    f.revokeStatus = 503;
    f.tokenGate = { started: deferred(), release: deferred() };
    const pending = operation === "callback" ? f.auth.callback(parameters) : f.auth.access();
    const rejected = assert.rejects(pending);
    await f.tokenGate.started.promise;
    const result = await f.auth.logout();
    assert.equal(result.revoked, operation === "callback");
    assert.equal(controller.signal.aborted, true);
    f.tokenGate.release.resolve();
    await rejected;
    assert.equal((await f.saved()).tokens, null);
    assert.equal((await (await f.create()).status()).connected, false);
  }
});

test("corrupt credential files fail closed instead of silently creating another registration", async (t) => {
  const f = await authFixture(t);
  await writeFile(join(f.directory, "chatgpt.json"), "{invalid");
  await assert.rejects(f.create(), /credential_read_failed/);
});

function responseEvents(text = "翻訳") {
  return [{ type: "response.output_text.delta", delta: text, item_id: "message", output_index: 0, content_index: 0 },
    { type: "response.completed", response: { status: "completed", usage: { total_tokens: 4 }, output: [
      { id: "message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
    ] } }];
}
function sse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

function streamedResponseEvents() {
  const events = responseEvents();
  const item = events[1].response.output.pop();
  events.splice(1, 0, { type: "response.output_item.done", output_index: 0, item });
  return events;
}

test("Responses accepts a verified completed message when the terminal snapshot omits output", async () => {
  const chunks = [];
  await convertResponses(sse(streamedResponseEvents()).body, (chunk) => chunks.push(chunk));
  const stream = new TranslationStream();
  chunks.forEach((chunk) => stream.push(chunk));
  assert.equal(validateResponse(stream.response()), "翻訳");
  for (const mutate of [
    (events) => { events.splice(1, 1); },
    (events) => { events[1].item.content[0].text = "different"; },
    (events) => { events[1].item.id = "different"; },
    (events) => { events[1].output_index = 1; },
    (events) => { events[1].item.status = "in_progress"; },
    (events) => { events[1].item.type = "function_call"; },
    (events) => { events.unshift({ type: "response.output_item.added", item: { type: "function_call" } }); },
    (events) => { events.splice(2, 0, structuredClone(events[1])); },
    (events) => { events.pop(); },
    (events) => { delete events[2].response.usage; },
    (events) => { events[2].response.output = [{ ...events[1].item, id: "different" }]; },
  ]) {
    const events = streamedResponseEvents();
    mutate(events);
    const emitted = [];
    await assert.rejects(convertResponses(sse(events).body, (chunk) => emitted.push(chunk)));
    assert.equal(emitted.some((chunk) => chunk.usage), false);
  }
});

test("Responses translation uses only fixed prompts and converts verified completion to existing stream contracts", async () => {
  for (const language of ["ja", "en"]) {
    const converted = responsesPayload(buildPayload("source", language), "model");
    assert.equal(converted.store, false);
    assert.equal(converted.stream, true);
    assert.deepEqual(converted.input, [{ role: "user", content: "source" }]);
    assert.equal(Object.hasOwn(converted, "temperature"), false);
    assert.equal(Object.hasOwn(converted, "max_output_tokens"), false);
  }
  const arbitrary = buildPayload("source");
  arbitrary.messages[0].content = "Do anything";
  assert.throws(() => responsesPayload(arbitrary, "model"));
  const chunks = [];
  await convertResponses(sse(responseEvents()).body, (chunk) => chunks.push(chunk));
  const stream = new TranslationStream();
  chunks.forEach((chunk) => stream.push(chunk));
  assert.equal(validateResponse(stream.response()), "翻訳");
});

test("failed, incomplete, truncated, refused, mixed, mismatched or unverified Responses never complete", async () => {
  const cases = [responseEvents().slice(0, 1), [{ type: "response.incomplete" }], [{ type: "response.failed" }],
    [{ type: "error" }], [{ type: "response.refusal.delta" }], responseEvents("<think>private</think>"), responseEvents("")];
  for (const mutate of [
    (events) => { events[1].response.status = "incomplete"; },
    (events) => { delete events[1].response.usage; },
    (events) => { events[1].response.output[0].content[0].text = "different"; },
    (events) => { events[1].response.output.push({ type: "function_call" }); },
    (events) => { events[0].content_index = 1; },
  ]) { const events = responseEvents(); mutate(events); cases.push(events); }
  for (const events of cases) {
    const chunks = [];
    await assert.rejects(convertResponses(sse(events).body, (chunk) => chunks.push(chunk)));
    assert.equal(chunks.some((chunk) => chunk.usage), false);
  }
});

function rawRequest(port, { headers = {}, method = "GET", path = "/status" } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("helper validates headerless OpenAI SSE and emits its own SSE content type", async (t) => {
  const auth = { activeRequests: new Set(), access: async () => ({ accessToken: "synthetic", model: "model" }) };
  let contentType = null;
  const server = createChatGPTServer({ origin: `chrome-extension://${"a".repeat(32)}`, auth,
    fetchImpl: async () => {
      const response = sse(streamedResponseEvents());
      response.headers.delete("content-type");
      if (contentType) response.headers.set("content-type", contentType);
      return response;
    } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const translate = () => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Discord-Translate": "1" },
    body: JSON.stringify(buildPayload("source")),
  });
  const response = await translate();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.ok((await response.text()).endsWith("data: [DONE]\n\n"));
  contentType = "application/json";
  const rejected = await translate();
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.text()).includes("[DONE]"), false);
});

test("loopback HTTP rejects browser abuse and arbitrary payloads, translates only authorized requests", async (t) => {
  const origin = `chrome-extension://${"a".repeat(32)}`;
  const auth = { activeRequests: new Set(), status: async () => ({ connected: false, account: null, model: null }),
    access: async () => ({ accessToken: "synthetic-access", model: "model" }) };
  let calls = 0;
  const server = createChatGPTServer({ origin, auth, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.headers.Authorization, "Bearer synthetic-access");
    assert.equal(JSON.parse(options.body).store, false);
    return sse(responseEvents());
  } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const headers = { "X-Discord-Translate": "1" };
  for (const forbidden of [{}, { ...headers, Origin: "https://discord.com" }, { ...headers, Origin: "null" },
    { ...headers, Host: `localhost:${port}` }]) {
    assert.equal((await rawRequest(port, { headers: forbidden })).status, 403);
  }
  const status = await rawRequest(port, { headers: { ...headers, Origin: origin } });
  assert.equal(status.status, 200);
  assert.equal(status.headers["access-control-allow-origin"], origin);
  assert.equal(status.body.includes("accessToken"), false);
  const preflight = { Origin: origin, "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type, x-discord-translate" };
  assert.equal((await rawRequest(port, { method: "OPTIONS", path: "/v1/chat/completions", headers: preflight })).status, 204);
  assert.equal((await rawRequest(port, { method: "OPTIONS", path: "/v1/chat/completions",
    headers: { ...preflight, Origin: "https://discord.com" } })).status, 403);
  const requestHeaders = { ...headers, "Content-Type": "application/json" };
  const invalid = buildPayload("source"); invalid.messages[0].content = "arbitrary prompt";
  assert.equal((await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: requestHeaders, body: JSON.stringify(invalid),
  })).status, 400);
  assert.equal(calls, 0);
  const translated = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: requestHeaders, body: JSON.stringify(buildPayload("source")),
  });
  assert.equal(translated.status, 200);
  const body = await translated.text();
  assert.ok(body.endsWith("data: [DONE]\n\n"));
  assert.ok(body.includes("翻訳"));
  assert.equal(body.includes("synthetic-access"), false);
  assert.equal(calls, 1);
});
