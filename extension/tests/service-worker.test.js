import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_PORT_NAME,
  BridgeRegistry,
  CACHE_TTL_MS,
  BRIDGE_REQUEST_TIMEOUT_MS,
  defaultBridgeRegistry,
  defaultTranslator,
  ERROR_CODES,
  FETCH_TIMEOUT_MS,
  MAX_CACHE_ENTRIES,
  MAX_UNIQUE_JOBS,
  QUEUE_WAIT_TIMEOUT_MS,
  TranslationError,
  TranslationQueue,
  buildPayload,
  fetchTranslation,
  handleTranslateMessage,
  sha256Hex,
  validateMessage,
  validateResponse,
  validateSender,
  validateBridgePortSender,
} from "../service-worker.js";

function responseFor(text, overrides = {}) {
  return {
    status: 200,
    async json() {
      return {
        choices: [{ finish_reason: "stop", message: { content: `訳:${text}` } }],
        usage: { total_tokens: 1 },
        ...overrides,
      };
    },
  };
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
    { messageId: "chat-messages-1-2", text: "hello" },
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

test("builds the fixed non-thinking, non-streaming payload", () => {
  const payload = buildPayload("source");
  assert.equal(payload.messages[1].content, "source");
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.chat_template_kwargs.enable_thinking, false);
  assert.equal(payload.temperature, 0.7);
  assert.equal(payload.top_p, 0.8);
  assert.equal(payload.top_k, 20);
  assert.equal(payload.min_p, 0);
  assert.equal(payload.max_tokens, 1024);
  assert.equal(payload.stream, false);
  assert.equal("model" in payload, false);
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

test("logs only fixed invalid-response diagnostics and stays silent for valid or other errors", async () => {
  const cases = [
    {
      payload: {
        choices: [{ finish_reason: "length", message: { content: "秘密の訳文" } }],
        usage: { total_tokens: 512 },
      },
      expected: {
        finish_reason: "length",
        content_present: true,
        reasoning_present: false,
        usage_total_tokens_present: true,
      },
    },
    {
      payload: {
        choices: [{ finish_reason: "stop", message: { content: null } }],
        usage: { total_tokens: 1 },
      },
      expected: {
        finish_reason: "stop",
        content_present: false,
        reasoning_present: false,
        usage_total_tokens_present: true,
      },
    },
    {
      payload: {
        choices: [{ finish_reason: "stop", message: { content: "<think>秘密の推論</think>訳" } }],
        usage: { total_tokens: 1 },
      },
      expected: {
        finish_reason: "stop",
        content_present: true,
        reasoning_present: true,
        usage_total_tokens_present: true,
      },
    },
    {
      payload: {
        choices: [{ finish_reason: "stop", message: { content: "秘密の訳文" } }],
        usage: {},
      },
      expected: {
        finish_reason: "stop",
        content_present: true,
        reasoning_present: false,
        usage_total_tokens_present: false,
      },
    },
    {
      payload: {
        choices: [{ finish_reason: "stop", message: { content: "秘密の訳文" } }],
        usage: { total_tokens: "512" },
      },
      expected: {
        finish_reason: "stop",
        content_present: true,
        reasoning_present: false,
        usage_total_tokens_present: false,
      },
    },
    {
      payload: {
        choices: [{ finish_reason: "stop", message: { content: "秘密の訳文" } }],
        usage: { total_tokens: -1 },
      },
      expected: {
        finish_reason: "stop",
        content_present: true,
        reasoning_present: false,
        usage_total_tokens_present: false,
      },
    },
  ];

  for (const item of cases) {
    const capture = diagnosticsLogger();
    await assert.rejects(
      fetchTranslation("秘密の入力", {
        logger: capture.logger,
        requestImpl: async () => ({ status: 200, json: async () => item.payload }),
      }),
      (value) => value.code === "invalid_response",
    );
    assert.deepEqual(capture.calls, [["invalid_response", item.expected]]);
    assert.equal(JSON.stringify(capture.calls).includes("秘密"), false);
  }

  const malformed = diagnosticsLogger();
  await assert.rejects(
    fetchTranslation("秘密の入力", {
      logger: malformed.logger,
      requestImpl: async () => ({ status: 200, json: async () => { throw new Error("秘密の例外"); } }),
    }),
    (value) => value.code === "invalid_response",
  );
  assert.deepEqual(malformed.calls, [["invalid_response", {
    finish_reason: null,
    content_present: false,
    reasoning_present: false,
    usage_total_tokens_present: false,
  }]]);
  assert.equal(JSON.stringify(malformed.calls).includes("秘密"), false);

  const valid = diagnosticsLogger();
  assert.equal(await fetchTranslation("source", {
    logger: valid.logger,
    requestImpl: async () => responseFor("source"),
  }), "訳:source");
  assert.deepEqual(valid.calls, []);

  const network = diagnosticsLogger();
  await assert.rejects(
    fetchTranslation("source", {
      logger: network.logger,
      requestImpl: async () => { throw new Error("network detail"); },
    }),
    (value) => value.code === "network_error",
  );
  assert.deepEqual(network.calls, []);
});

test("coalesces duplicate jobs and processes FIFO with concurrency one", async () => {
  const calls = [];
  const pending = [];
  const queue = new TranslationQueue({
    hashImpl: (text) => text,
    requestImpl: async (_tabId, payload) => {
      const text = payload.messages[1].content;
      calls.push(text);
      await new Promise((resolve) => pending.push(resolve));
      return responseFor(text);
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
    .filter((timer) => timer.active && timer.ms === QUEUE_WAIT_TIMEOUT_MS)
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
  const timeout = timers.timers.find((timer) => timer.active && timer.ms === FETCH_TIMEOUT_MS);
  assert.ok(timeout);
  assert.equal(FETCH_TIMEOUT_MS, 120_000);
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
    assert.equal(typeof defaultTranslator.requestImpl, "function");
    assert.equal(port.messages.length, 1);
    assert.equal(port.messages[0].type, "translate");
    assert.equal(port.messages[0].payload.messages[1].content, "phase-5-6-default-bridge-test");
    port.receive({
      type: "result",
      jobId: port.messages[0].jobId,
      status: 200,
      payload: {
        choices: [{ finish_reason: "stop", message: { content: "訳" } }],
        usage: { total_tokens: 1 },
      },
    });
    assert.deepEqual(await settled, { value: "訳" });
    assert.equal(fetchCalls, 0);
  } finally {
    await settled;
    port.disconnect();
    globalThis.fetch = originalFetch;
  }
});

test("service-worker execution and queue timeouts are 120 seconds", () => {
  assert.equal(FETCH_TIMEOUT_MS, 120_000);
  assert.equal(BRIDGE_REQUEST_TIMEOUT_MS, 120_000);
  assert.equal(QUEUE_WAIT_TIMEOUT_MS, 120_000);
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
    requestImpl: async (_tabId, payload) => {
      calls += 1;
      return responseFor(payload.messages[1].content);
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

test("returns fixed errors at the message boundary without fetching invalid input", async () => {
  let called = false;
  const translator = {
    translate: async () => {
      called = true;
      return "訳";
    },
  };
  const sender = {
    id: "extension-id",
    frameId: 0,
    url: "https://discord.com/channels/1/2",
    tab: { id: 1 },
  };
  assert.deepEqual(
    await handleTranslateMessage({
      message: { type: "translate", messageId: "chat-messages-1-2", text: "source" },
      sender,
      runtimeId: "extension-id",
      translator,
    }),
    { ok: true, text: "訳" },
  );
  assert.equal(called, true);
  called = false;
  assert.deepEqual(
    await handleTranslateMessage({
      message: { type: "translate", messageId: "chat-messages-1-2", text: "source" },
      sender: { ...sender, frameId: 1 },
      runtimeId: "extension-id",
      translator,
    }),
    { ok: false, error: "invalid_sender" },
  );
  assert.equal(called, false);
  for (const code of ["hash_error", "lna_denied"]) {
    const failingTranslator = {
      translate: async () => { throw new TranslationError(code); },
    };
    assert.deepEqual(
      await handleTranslateMessage({
        message: { type: "translate", messageId: "chat-messages-1-2", text: "source" },
        sender,
        runtimeId: "extension-id",
        translator: failingTranslator,
      }),
      { ok: false, error: code },
    );
  }
  assert.deepEqual(
    await handleTranslateMessage({
      message: { type: "translate", messageId: "chat-messages-1-2", text: "source" },
      sender,
      runtimeId: "extension-id",
      translator: { translate: async () => { throw { unexpected: true }; } },
    }),
    { ok: false, error: "network_error" },
  );
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
  port.receive({
    type: "result",
    jobId: port.messages[0].jobId,
    status: 200,
    payload: { choices: [] },
  });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { choices: [] });
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
  port.receive({ type: "error", jobId: port.messages[1].jobId, error: "lna_denied" });
  await assert.rejects(denied, (value) => value.code === "lna_denied");
});

test("keeps queue and final API validation in the service worker while using the tab bridge for HTTP", async () => {
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const registry = new BridgeRegistry();
  const port = fakePort({ id: "extension-id", frameId: 1, url: bridgeUrl, tab: { id: 12 } });
  registry.connect(port, "extension-id", bridgeUrl);
  const queue = new TranslationQueue({
    hashImpl: (text) => text,
    requestImpl: (tabId, payload, options) => registry.request(tabId, payload, options),
  });
  const translation = queue.translate("source", 12);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.messages.length, 1);
  assert.deepEqual(port.messages[0].payload.messages[1].content, "source");
  port.receive({
    type: "result",
    jobId: port.messages[0].jobId,
    status: 200,
    payload: {
      choices: [{ finish_reason: "stop", message: { content: "訳" } }],
      usage: { total_tokens: 1 },
    },
  });
  assert.equal(await translation, "訳");
});
