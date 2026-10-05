import test from "node:test";
import assert from "node:assert/strict";
import { handleBridgeRequest } from "../bridge.js";
import {
  BRIDGE_PORT_NAME,
  BridgeRegistry,
  CACHE_TTL_MS,
  defaultBridgeRegistry,
  defaultTranslator,
  ERROR_CODES,
  MAX_CACHE_ENTRIES,
  MAX_UNIQUE_JOBS,
  TranslationError,
  TranslationQueue,
  buildPayload,
  fetchTranslation,
  connectRequestPort,
  REQUEST_PORT_NAME,
  TranslationStream,
  sha256Hex,
  validateMessage,
  validateResponse,
  validateSender,
  validateBridgePortSender,
} from "../service-worker.js";

function responseFor(text, options) {
  options.onChunk({ choices: [{ delta: { content: `訳:${text}` }, finish_reason: "stop" }] });
  options.onChunk({ choices: [], usage: { total_tokens: 1 } });
  return { status: 200 };
}

function completePort(port, text = "訳") {
  const jobId = port.messages.filter((message) => message.type === "translate").at(-1).jobId;
  port.receive({ type: "chunk", jobId, payload: {
    choices: [{ delta: { content: text }, finish_reason: "stop" }],
  } });
  port.receive({ type: "chunk", jobId, payload: { choices: [], usage: { total_tokens: 1 } } });
  port.receive({ type: "end", jobId });
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, ms) {
      const timer = { callback, ms, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.active = false;
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

test("validates trusted sender and exact translation input", () => {
  const sender = {
    id: "extension-id",
    frameId: 0,
    url: "https://discord.com/channels/1/2",
    tab: { id: 7 },
  };
  assert.equal(validateSender(sender, "extension-id"), true);
  assert.equal(validateSender({ ...sender, url: undefined }, "extension-id"), false);
  assert.equal(validateSender({ ...sender, frameId: 1 }, "extension-id"), false);
  assert.equal(validateSender({ ...sender, id: "other" }, "extension-id"), false);
  assert.equal(validateSender({ ...sender, url: "https://example.com/" }, "extension-id"), false);
  assert.equal(validateSender({ ...sender, tab: { id: 7, url: "https://discord.com/channels/1/2" }, url: undefined }, "extension-id"), false);

  assert.deepEqual(
    validateMessage({ type: "translate", messageId: "chat-messages-1-2", text: " hello " }),
    { messageId: "chat-messages-1-2", text: "hello", targetLanguage: "ja" },
  );
  assert.throws(
    () => validateMessage({ type: "translate", messageId: "chat-messages-1-2", text: " " }),
    (value) => value instanceof TranslationError && value.code === "invalid_input",
  );
  assert.throws(
    () => validateMessage({ type: "translate", messageId: "chat-messages-1-2", text: "x", extra: true }),
    (value) => value.code === "invalid_input",
  );
  assert.throws(
    () => validateMessage({ type: "translate", messageId: "not-a-message", text: "x" }),
    (value) => value.code === "invalid_input",
  );
});

test("builds the fixed non-thinking streaming payload with usage", () => {
  const payload = buildPayload("source");
  assert.equal(payload.messages[1].content, "source");
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.chat_template_kwargs.enable_thinking, false);
  assert.equal(payload.temperature, 0.7);
  assert.equal(payload.top_p, 0.8);
  assert.equal(payload.top_k, 20);
  assert.equal(payload.min_p, 0);
  assert.equal(payload.max_tokens, 1024);
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.equal("model" in payload, false);
});

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

test("translation directions separate running jobs and cached results but coalesce same-direction drafts", async () => {
  const calls = [];
  const pending = [];
  const queue = new TranslationQueue({
    requestImpl: async (_tabId, payload, options) => {
      const language = /natural English/.test(payload.messages[0].content) ? "en" : "ja";
      calls.push(language);
      await new Promise((resolve) => pending.push(resolve));
      return responseFor(language, options);
    },
  });
  const ja = queue.translate("same");
  const en = queue.translate("same", 1, { targetLanguage: "en" });
  const duplicate = queue.translate(" same ", 2, { targetLanguage: "en" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["ja"]);
  pending.shift()();
  assert.equal(await ja, "訳:ja");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["ja", "en"]);
  pending.shift()();
  assert.equal(await en, "訳:en");
  assert.equal(await duplicate, "訳:en");
  assert.equal(await queue.translate("same"), "訳:ja");
  assert.equal(await queue.translate("same", 1, { targetLanguage: "en" }), "訳:en");
  assert.deepEqual(calls, ["ja", "en"]);
  await assert.rejects(queue.translate("same", 1, { targetLanguage: "de" }),
    (value) => value.code === "invalid_input");
});

test("validates response schema, finish reason, usage, and thinking markers", () => {
  assert.equal(validateResponse({
    choices: [{ finish_reason: "stop", message: { content: " 訳 " } }],
    usage: { total_tokens: 2 },
  }), "訳");
  for (const payload of [
    { choices: [], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "length", message: { content: "訳" } }], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "stop", message: { content: "" } }], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "stop", message: { content: "<THINK>hidden</THINK>" } }], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "stop", message: { content: "訳", reasoning: "hidden" } }], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "stop", message: { content: "訳" } }], usage: {} },
  ]) {
    assert.throws(() => validateResponse(payload), (value) => value.code === "invalid_response");
  }
});

test("stream rejects invalid finish, usage, thinking and schema without logging private text", async () => {
  const cases = [
    { choices: [{ finish_reason: "length", delta: { content: "秘密の訳文" } }] },
    { choices: [{ finish_reason: "stop", delta: { content: null } }] },
    { choices: [{ delta: { content: "<think>秘密</think>" } }] },
    { choices: [{ delta: { content: "訳", reasoning: "秘密" } }] },
    { choices: [], usage: { total_tokens: 1 } },
  ];
  for (const chunk of cases) {
    const capture = diagnosticsLogger();
    await assert.rejects(fetchTranslation("秘密の入力", {
      logger: capture.logger,
      requestImpl: async (_payload, options) => { options.onChunk(chunk); return { status: 200 }; },
    }), (value) => value.code === "invalid_response");
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0][0], "invalid_response");
    assert.deepEqual(Object.keys(capture.calls[0][1]).sort(),
      ["content_present", "finish_reason", "reasoning_present", "usage_total_tokens_present"]);
    assert.equal(JSON.stringify(capture.calls).includes("秘密"), false);
  }
  const valid = diagnosticsLogger();
  assert.equal(await fetchTranslation("source", {
    logger: valid.logger,
    requestImpl: async (_payload, options) => responseFor("source", options),
  }), "訳:source");
  assert.deepEqual(valid.calls, []);
  const network = diagnosticsLogger();
  await assert.rejects(fetchTranslation("source", {
    logger: network.logger,
    requestImpl: async () => { throw new Error("private network detail"); },
  }), (value) => value.code === "network_error");
  assert.deepEqual(network.calls, []);
});

test("coalesces duplicate jobs and processes FIFO with concurrency one", async () => {
  const calls = [];
  const pending = [];
  const queue = new TranslationQueue({
    hashImpl: (text) => text,
    requestImpl: async (_tabId, payload, options) => {
      const text = payload.messages[1].content;
      calls.push(text);
      await new Promise((resolve) => pending.push(resolve));
      return responseFor(text, options);
    },
  });

  const first = queue.translate("first");
  const duplicate = queue.translate(" first ");
  const second = queue.translate("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first"]);
  pending.shift()();
  assert.equal(await first, "訳:first");
  assert.equal(await duplicate, "訳:first");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first", "second"]);
  pending.shift()();
  assert.equal(await second, "訳:second");
});

test("rejects a new key at the unique queue limit", async () => {
  const timers = fakeTimers();
  const queue = new TranslationQueue({
    hashImpl: (text) => text,
    maxJobs: 2,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    requestImpl: () => new Promise(() => {}),
  });
  void queue.translate("one");
  void queue.translate("two");
  const third = queue.translate("three");
  await assert.rejects(third, (value) => value.code === "queue_full");
  assert.equal(MAX_UNIQUE_JOBS, 64);
});

test("expires queued jobs without fetching them", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const queue = new TranslationQueue({
    hashImpl: (text) => text,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    requestImpl: () => {
      calls += 1;
      return new Promise(() => {});
    },
  });
  void queue.translate("running");
  const queued = queue.translate("queued");
  await new Promise((resolve) => setImmediate(resolve));
  const timeout = timers.timers
    .filter((timer) => timer.active && timer.ms === 120_000)
    .at(-1);
  assert.ok(timeout);
  timeout.callback();
  await assert.rejects(queued, (value) => value.code === "queue_timeout");
  assert.equal(calls, 1);
});

test("aborts a request after the fixed request timeout", async () => {
  const timers = fakeTimers();
  const request = fetchTranslation("source", {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    requestImpl: (_payload, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const timeout = timers.timers.find((timer) => timer.active && timer.ms === 120_000);
  assert.ok(timeout);
  timeout.callback();
  await assert.rejects(request, (value) => value.code === "request_timeout");
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(port.messages.length, 1);
    assert.equal(port.messages[0].type, "translate");
    assert.equal(port.messages[0].payload.messages[1].content, "phase-5-6-default-bridge-test");
    completePort(port);
    assert.deepEqual(await settled, { value: "訳" });
    assert.equal(fetchCalls, 0);
  } finally {
    await settled;
    port.disconnect();
    globalThis.fetch = originalFetch;
  }
});

test("normalizes Web Crypto failures to hash_error", async () => {
  await assert.rejects(
    sha256Hex("source", {}),
    (value) => value.code === "hash_error",
  );
  await assert.rejects(
    sha256Hex("source", { subtle: { digest: async () => { throw new Error("digest"); } } }),
    (value) => value.code === "hash_error",
  );
});

test("classifies local network permission failures separately from generic fetch failures", async () => {
  for (const name of ["NotAllowedError", "SecurityError"]) {
    const request = fetchTranslation("source", {
      requestImpl: async () => {
        const value = new Error("permission");
        value.name = name;
        throw value;
      },
    });
    await assert.rejects(request, (value) => value.code === "lna_denied");
  }

  await assert.rejects(
    fetchTranslation("source", { requestImpl: async () => { throw new Error("network"); } }),
    (value) => value.code === "network_error",
  );
});

test("uses successful translations in an expiring LRU cache", async () => {
  let now = 0;
  let calls = 0;
  const queue = new TranslationQueue({
    hashImpl: (text) => text,
    now: () => now,
    cacheLimit: 2,
    cacheTtlMs: 10,
    requestImpl: async (_tabId, payload, options) => {
      calls += 1;
      return responseFor(payload.messages[1].content, options);
    },
  });

  assert.equal(await queue.translate("a"), "訳:a");
  assert.equal(await queue.translate("a"), "訳:a");
  assert.equal(calls, 1);
  await queue.translate("b");
  await queue.translate("a");
  await queue.translate("c");
  await queue.translate("b");
  assert.equal(calls, 4);
  now = 11;
  await queue.translate("a");
  assert.equal(calls, 5);
  assert.equal(MAX_CACHE_ENTRIES, 256);
  assert.equal(CACHE_TTL_MS, 30 * 60 * 1000);
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
    });
    target.receive({ type: "translate", messageId: "chat-messages-1-2", text: "source" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(target.messages, code ? [{ type: "error", error: code }] : [
      { type: "progress", text: "途" }, { type: "result", text: "途中訳" },
    ]);
    target.receive({ type: "translate", messageId: "chat-messages-1-2", text: "source" });
    assert.equal(target.messages.length, code ? 1 : 2);
  }
  assert.ok(ERROR_CODES.includes("invalid_response"));
});

function fakePort(sender, name = BRIDGE_PORT_NAME) {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    name,
    sender,
    messages: [],
    disconnected: false,
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(message) { this.messages.push(message); },
    disconnect() {
      this.disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
    receive(message) {
      for (const listener of messageListeners) listener(message);
    },
  };
}

test("accepts only the exact child bridge sender and routes a job to its tab", async () => {
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const sender = {
    id: "extension-id",
    frameId: 2,
    url: bridgeUrl,
    tab: { id: 7 },
  };
  assert.equal(validateBridgePortSender(sender, "extension-id", bridgeUrl), true);
  assert.equal(validateBridgePortSender({ ...sender, frameId: 0 }, "extension-id", bridgeUrl), false);
  assert.equal(validateBridgePortSender({ ...sender, url: "chrome-extension://other/bridge.html" }, "extension-id", bridgeUrl), false);
  assert.equal(validateBridgePortSender({ ...sender, tab: { id: 7.5 } }, "extension-id", bridgeUrl), false);

  const registry = new BridgeRegistry();
  const port = fakePort(sender);
  assert.equal(registry.connect(port, "extension-id", bridgeUrl), true);
  const pending = registry.request(7, { fixed: true });
  assert.equal(port.messages.length, 1);
  assert.equal(port.messages[0].type, "translate");
  assert.equal(typeof port.messages[0].jobId, "string");
  assert.deepEqual(port.messages[0].payload, { fixed: true });
  // The pending request remains open for multiple intermediate events.
  port.receive({ type: "chunk", jobId: port.messages[0].jobId, payload: { choices: [] } });
  assert.equal(registry.pending.size, 1);
  port.receive({ type: "end", jobId: port.messages[0].jobId });
  assert.deepEqual(await pending, { status: 200 });
});

test("stream preserves whitespace and holds split thinking markers and surrogate pairs", () => {
  const progress = [];
  const stream = new TranslationStream((text) => progress.push(text));
  stream.push({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] });
  stream.push({ choices: [{ delta: { content: " 訳\n" } }] });
  stream.push({ choices: [{ delta: { content: "\uD83D" } }] });
  assert.equal(progress.at(-1), " 訳\n");
  stream.push({ choices: [{ delta: { content: "\uDE80" } }] });
  assert.equal(progress.at(-1), " 訳\n🚀");
  stream.push({ choices: [{ delta: { content: "<Th" } }] });
  assert.equal(progress.at(-1), " 訳\n🚀");
  assert.throws(() => stream.push({ choices: [{ delta: { content: "INK>secret" } }] }),
    (value) => value.code === "invalid_response");
});

test("stream rejects missing or duplicate completion metadata, tools and oversized content", () => {
  for (const chunks of [
    [],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }, { choices: [], usage: {} }],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }, { choices: [], usage: { total_tokens: -1 } }],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }, { choices: [], usage: { total_tokens: 1 } }, { choices: [], usage: { total_tokens: 1 } }],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }, { choices: [{ delta: { content: "after" } }] }],
    [{ choices: [{ delta: { reasoning_content: "private" } }] }],
    [{ choices: [{ delta: { tool_calls: [] } }] }],
    [{ choices: [{ delta: { role: "user" } }] }],
    [{ choices: [{ delta: { content: "x".repeat(64 * 1024 + 1) } }] }],
  ]) {
    assert.throws(() => {
      const stream = new TranslationStream();
      for (const chunk of chunks) stream.push(chunk);
      validateResponse(stream.response());
    }, (value) => value.code === "invalid_response");
  }
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

test("does not route a content job to another tab and fails on bridge disconnect", async () => {
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const registry = new BridgeRegistry();
  const port = fakePort({ id: "extension-id", frameId: 1, url: bridgeUrl, tab: { id: 9 } });
  registry.connect(port, "extension-id", bridgeUrl);
  const pending = registry.request(9, { fixed: true });
  assert.equal(port.messages.length, 1);
  port.disconnect();
  await assert.rejects(pending, (value) => value.code === "bridge_unavailable");
  const abort = new AbortController();
  const wrongTab = registry.request(10, { fixed: true }, { signal: abort.signal });
  abort.abort();
  await assert.rejects(wrongTab, (value) => value.code === "request_timeout");
});

test("normalizes malformed bridge responses and bridge errors", async () => {
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const registry = new BridgeRegistry();
  const port = fakePort({ id: "extension-id", frameId: 1, url: bridgeUrl, tab: { id: 11 } });
  registry.connect(port, "extension-id", bridgeUrl);

  const malformed = registry.request(11, { fixed: true });
  port.receive({ type: "result", jobId: port.messages[0].jobId, status: 200 });
  await assert.rejects(malformed, (value) => value.code === "invalid_response");

  const denied = registry.request(11, { fixed: true });
  port.receive({ type: "error", jobId: port.messages.filter((message) => message.type === "translate").at(-1).jobId, error: "lna_denied" });
  await assert.rejects(denied, (value) => value.code === "lna_denied");
});
