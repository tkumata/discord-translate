import test from "node:test";
import assert from "node:assert/strict";
import { CACHE_TTL_MS, MAX_CACHE_ENTRIES, MAX_UNIQUE_JOBS, TranslationQueue, runTranslationRequest, sha256Hex } from "../translation-queue.js";
import { responseFor, fakeTimers, diagnosticsLogger } from "./worker-test-fixture.js";

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
    await assert.rejects(runTranslationRequest("秘密の入力", {
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
  assert.equal(await runTranslationRequest("source", {
    logger: valid.logger,
    requestImpl: async (_payload, options) => responseFor("source", options),
  }), "訳:source");
  assert.deepEqual(valid.calls, []);
  const network = diagnosticsLogger();
  await assert.rejects(runTranslationRequest("source", {
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

test("skips overdue jobs when a running request finishes before deadline timers fire", async () => {
  const timers = fakeTimers();
  let now = 0;
  let completeFirst;
  const calls = [];
  const queue = new TranslationQueue({
    hashImpl: (text) => text,
    now: () => now,
    queueWaitMs: 100,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    requestImpl: async (_tabId, payload, options) => {
      const text = payload.messages[1].content;
      calls.push(text);
      if (text === "first") await new Promise((resolve) => { completeFirst = resolve; });
      return responseFor(text, options);
    },
  });
  const first = queue.translate("first");
  const overdue = queue.translate("overdue");
  const rejected = assert.rejects(overdue, (value) => value.code === "queue_timeout");
  await new Promise((resolve) => setImmediate(resolve));
  now = 99;
  const fresh = queue.translate("fresh");
  await new Promise((resolve) => setImmediate(resolve));
  now = 101;
  completeFirst();
  assert.equal(await first, "訳:first");
  await rejected;
  assert.equal(await fresh, "訳:fresh");
  assert.deepEqual(calls, ["first", "fresh"]);
  assert.equal(timers.timers.filter((timer) => timer.ms === 100 && timer.active).length, 0);
});

test("aborts a request after the fixed request timeout", async () => {
  const timers = fakeTimers();
  const request = runTranslationRequest("source", {
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
    const request = runTranslationRequest("source", {
      requestImpl: async () => {
        const value = new Error("permission");
        value.name = name;
        throw value;
      },
    });
    await assert.rejects(request, (value) => value.code === "lna_denied");
  }

  await assert.rejects(
    runTranslationRequest("source", { requestImpl: async () => { throw new Error("network"); } }),
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
