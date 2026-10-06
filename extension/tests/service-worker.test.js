import test from "node:test";
import assert from "node:assert/strict";
import { handleBridgeRequest } from "../bridge.js";
import { createReceivedTranslationCache } from "../received-translation-cache.js";
import { storageFixture, waitFor } from "./storage-fixture.js";
import { BridgeRegistry } from "../bridge-registry.js";
import { TranslationQueue, sha256Hex } from "../translation-queue.js";
import { defaultBridgeRegistry, defaultTranslator, connectRequestPort, REQUEST_PORT_NAME } from "../service-worker.js";
import { ERROR_CODES, TranslationError, buildPayload, validateMessage } from "../translation-protocol.js";
import { responseFor, completePort, fakePort } from "./worker-test-fixture.js";

test("draft requests select only the fixed English prompt and retain the existing message contract", async () => {
  assert.deepEqual(validateMessage({ type: "translateDraft", text: " 日本語 " }), {
    text: "日本語", targetLanguage: "en",
  });
  for (const input of [
    { type: "unknown", text: "日本語" },
    { type: "translateDraft", messageId: "chat-messages-1-2", text: "日本語" },
    { type: "translateDraft", targetLanguage: "en", text: "日本語" },
    { type: "translateDraft", text: " " },
    { type: "translateDraft", text: 1 },
    { type: "translateDraft", text: "x".repeat(8001) },
  ]) assert.throws(() => validateMessage(input), (value) => value.code === "invalid_input");
  const japanese = buildPayload("日本語");
  const english = buildPayload("日本語", "en");
  assert.match(japanese.messages[0].content, /natural Japanese/);
  assert.match(english.messages[0].content, /natural English/);
  assert.deepEqual({ ...english, messages: japanese.messages }, japanese);
  assert.throws(() => buildPayload("日本語", "de"), (value) => value.code === "invalid_input");

  const sender = { id: "extension-id", frameId: 0, url: "https://discord.com/channels/1/2", tab: { id: 1 } };
  const port = fakePort(sender, REQUEST_PORT_NAME);
  const queue = new TranslationQueue({
    requestImpl: async (tabId, payload, options) => {
      assert.equal(tabId, 1);
      assert.match(payload.messages[0].content, /natural English/);
      return responseFor("English", options);
    },
  });
  connectRequestPort(port, "extension-id", queue);
  port.receive({ type: "translateDraft", text: "日本語" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages.at(-1), { type: "result", text: "訳:English" });
});

test("default translation delegates to the tab bridge without using global fetch", async () => {
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const tabId = 13;
  const port = fakePort({ id: "extension-id", frameId: 1, url: bridgeUrl, tab: { id: tabId } });
  assert.equal(defaultBridgeRegistry.connect(port, "extension-id", bridgeUrl), true);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => {
    fetchCalls += 1;
    throw new Error("global fetch should not be used");
  };
  const translation = defaultTranslator.translate("phase-5-6-default-bridge-test", tabId);
  const settled = translation.then(
    (value) => ({ value }),
    (errorValue) => ({ error: errorValue }),
  );
  try {
    await waitFor(() => port.messages.length > 0);
    assert.equal(port.messages.length, 1);
    assert.equal(port.messages[0].type, "translate");
    assert.equal(port.messages[0].payload.messages[1].content, "phase-5-6-default-bridge-test");
    completePort(port);
    assert.deepEqual(await settled, { value: "訳" });
    assert.equal(fetchCalls, 0);
  } finally {
    port.disconnect();
    await settled;
    globalThis.fetch = originalFetch;
  }
});

test("request ports validate sender/input and return only fixed outcomes", async () => {
  const sender = { id: "extension-id", frameId: 0, url: "https://discord.com/channels/1/2", tab: { id: 1 } };
  let calls = 0;
  const translator = { translate: async () => { calls++; return "訳"; } };
  const invalidSender = fakePort({ ...sender, frameId: 1 }, REQUEST_PORT_NAME);
  assert.equal(connectRequestPort(invalidSender, "extension-id", translator), false);
  assert.equal(invalidSender.disconnected, true);
  const invalidInput = fakePort(sender, REQUEST_PORT_NAME);
  connectRequestPort(invalidInput, "extension-id", translator);
  invalidInput.receive({ type: "translate", messageId: "wrong", text: "source" });
  assert.deepEqual(invalidInput.messages, [{ type: "error", error: "invalid_input" }]);
  assert.equal(calls, 0);
  for (const code of [null, "hash_error", "lna_denied"]) {
    const target = fakePort(sender, REQUEST_PORT_NAME);
    connectRequestPort(target, "extension-id", {
      translate: async (_text, _tabId, options) => {
        if (code) throw new TranslationError(code);
        options.onProgress("途");
        return "途中訳";
      },
    }, createReceivedTranslationCache(storageFixture(), { hashImpl: sha256Hex }));
    target.receive({ type: "translate", messageId: "chat-messages-1-2", text: "source" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(target.messages, code ? [{ type: "error", error: code }] : [
      { type: "progress", text: "途" }, { type: "result", text: "途中訳", cache: { saved: true, error: null } },
    ]);
    target.receive({ type: "translate", messageId: "chat-messages-1-2", text: "source" });
    assert.equal(target.messages.length, code ? 1 : 2);
  }
  assert.ok(ERROR_CODES.includes("invalid_response"));
});

test("duplicate and late subscribers share progress, while unsubscribe does not cancel their job", async () => {
  const registry = new BridgeRegistry();
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const bridge = fakePort({ id: "extension-id", frameId: 1, url: bridgeUrl, tab: { id: 12 } });
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const pending = new Map();
  const transportTasks = [];
  bridge.postMessage = (message) => {
    bridge.messages.push(message);
    transportTasks.push(handleBridgeRequest({ postMessage: (event) => bridge.receive(event) }, message, pending, {
      fetchImpl: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    }));
  };
  registry.connect(bridge, "extension-id", bridgeUrl);
  const queue = new TranslationQueue({
    hashImpl: (text) => text,
    requestImpl: (tabId, payload, options) => registry.request(tabId, payload, options),
  });
  const firstProgress = [];
  const lateProgress = [];
  const abort = new AbortController();
  const first = queue.translate("source", 12, { onProgress: (text) => firstProgress.push(text), signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  const emit = (payload) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
  emit({ choices: [{ delta: { content: "途中" } }] });
  await new Promise((resolve) => setImmediate(resolve));
  const late = queue.translate(" source ", 99, { onProgress: (text) => lateProgress.push(text) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lateProgress, ["途中"]);
  abort.abort();
  emit({ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] });
  emit({ choices: [], usage: { total_tokens: 4 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.cache.size, 0);
  controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  controller.close();
  assert.equal(await first, "途中訳");
  assert.equal(await late, "途中訳");
  assert.deepEqual(firstProgress, ["途中"]);
  assert.deepEqual(lateProgress, ["途中", "途中訳"]);
  assert.equal(await queue.translate("source", 12), "途中訳");
  assert.equal(bridge.messages.filter((message) => message.type === "translate").length, 1);
  await Promise.all(transportTasks);
  assert.equal(pending.size, 0);
  assert.equal(registry.pending.size, 0);
});

test("invalid stream aborts the bridge and is never cached", async () => {
  const registry = new BridgeRegistry();
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const bridge = fakePort({ id: "extension-id", frameId: 1, url: bridgeUrl, tab: { id: 12 } });
  registry.connect(bridge, "extension-id", bridgeUrl);
  const queue = new TranslationQueue({
    logger: { warn() {} }, hashImpl: (text) => text,
    requestImpl: (tabId, payload, options) => registry.request(tabId, payload, options),
  });
  const request = queue.translate("source", 12);
  await new Promise((resolve) => setImmediate(resolve));
  const jobId = bridge.messages[0].jobId;
  bridge.receive({ type: "chunk", jobId, payload: { choices: [{ delta: { content: "途中" }, finish_reason: "length" }] } });
  await assert.rejects(request, (value) => value.code === "invalid_response");
  assert.deepEqual(bridge.messages.at(-1), { type: "abort", jobId });
  assert.equal(queue.cache.size, 0);
  bridge.receive({ type: "end", jobId });
  assert.equal(queue.cache.size, 0);
});
