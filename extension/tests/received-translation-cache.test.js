import test from "node:test";
import assert from "node:assert/strict";
import { createReceivedTranslationCache, RECEIVED_CACHE_PREFIX, RECEIVED_CACHE_TTL_MS } from "../received-translation-cache.js";
import { sha256Hex } from "../service-worker.js";
import { storageFixture, workerFixture, waitFor } from "./storage-fixture.js";

const source = { messageId: "chat-messages-1-2", text: "private-source-marker" };
const lookupMessage = (message = source) => ({ type: "lookupTranslation", ...message });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const cacheFor = (storage, options = {}) => createReceivedTranslationCache(storage, { hashImpl: sha256Hex, ...options });

test("received translations survive worker recreation for five days without extending their deadline", async () => {
  let now = 100;
  const storage = storageFixture({ enabled: true });
  const cache = cacheFor(storage, { now: () => now });
  assert.deepEqual(await cache.save(source, "完成訳"), { saved: true, error: null });
  const key = Object.keys(storage.data).find((key) => key.startsWith(RECEIVED_CACHE_PREFIX));
  assert.match(key, /^receivedTranslation:v1:chat-messages-1-2:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(storage.data).includes(source.text), false);
  const expiresAt = storage.data[key].expiresAt;
  now += 1000;
  await cache.save(source, "完成訳");
  assert.equal(storage.data[key].expiresAt, expiresAt);
  const recreated = cacheFor(storage, { now: () => now });
  assert.equal((await recreated.lookup({ ...source, text: ` ${source.text} ` })).text, "完成訳");
  assert.equal((await recreated.lookup({ ...source, text: "edited" })).status, "miss");
  assert.equal((await recreated.lookup({ ...source, messageId: "chat-messages-1-3" })).status, "miss");
  now = expiresAt - 1;
  assert.equal((await recreated.lookup(source)).status, "hit");
  now = expiresAt;
  assert.equal((await recreated.lookup(source)).status, "miss");
  assert.equal(key in storage.data, false);
  assert.equal(storage.data.enabled, true);
  await recreated.save(source, "新しい完成訳");
  assert.equal(storage.data[key].expiresAt, now + RECEIVED_CACHE_TTL_MS);
});

test("individual concurrent saves keep more than 256 unexpired messages and preserve enabled", async () => {
  const storage = storageFixture({ enabled: false });
  const cache = cacheFor(storage);
  const outcomes = await Promise.all(Array.from({ length: 257 }, (_, index) =>
    cache.save({ messageId: `chat-messages-1-${index}`, text: `source-${index}` }, `訳-${index}`)));
  assert.ok(outcomes.every((value) => value.saved));
  assert.equal(Object.keys(storage.data).filter((key) => key.startsWith(RECEIVED_CACHE_PREFIX)).length, 257);
  assert.equal((await cache.lookup({ messageId: "chat-messages-1-0", text: "source-0" })).text, "訳-0");
  assert.equal(storage.data.enabled, false);
});

test("corrupt and expired values are excluded and cleanup cannot remove settings or fresh entries", async () => {
  const storage = storageFixture({ enabled: true, foreign: "keep" });
  const cache = cacheFor(storage, { now: () => 10 });
  await cache.save(source, "新訳");
  storage.data[`${RECEIVED_CACHE_PREFIX}expired`] = { version: 1, text: "旧訳", savedAt: 0, expiresAt: 1 };
  await cache.cleanup();
  assert.equal(`${RECEIVED_CACHE_PREFIX}expired` in storage.data, false);
  assert.equal((await cache.lookup(source)).status, "hit");
  const key = Object.keys(storage.data).find((key) => key.startsWith(RECEIVED_CACHE_PREFIX));
  storage.data[key].expiresAt = Infinity;
  assert.equal((await cache.lookup(source)).status, "miss");
  assert.equal(key in storage.data, false);
  assert.equal(storage.data.foreign, "keep");
  assert.equal(storage.data.enabled, true);
});

test("quota and storage errors report fixed codes without evicting unexpired translations", async () => {
  const storage = storageFixture({ enabled: true });
  const cache = cacheFor(storage);
  await cache.save(source, "保持する訳");
  let writes = 0;
  storage.set = async () => { writes++; throw new Error("QUOTA_BYTES private details"); };
  assert.deepEqual(await cache.save({ ...source, messageId: "chat-messages-1-3" }, "新訳"),
    { saved: false, error: "cache_write_failed" });
  assert.equal(writes, 2);
  assert.equal((await cache.lookup(source)).text, "保持する訳");
  storage.get = async () => { throw new Error("private read details"); };
  assert.deepEqual(await cache.lookup(source), { status: "miss", error: "cache_read_failed" });
});

test("failed deletion is observable while expiry is enforced and valid writes can still succeed", async () => {
  const storage = storageFixture();
  let now = 1;
  const cache = cacheFor(storage, { now: () => now });
  await cache.save(source, "旧訳");
  now += RECEIVED_CACHE_TTL_MS;
  storage.remove = async () => { throw new Error("private delete details"); };
  assert.deepEqual(await cache.lookup(source), { status: "miss", error: "cache_cleanup_failed" });
  assert.equal(await cache.cleanup(), "cache_cleanup_failed");
  assert.deepEqual(await cache.save({ ...source, messageId: "chat-messages-1-3" }, "新訳"),
    { saved: true, error: "cache_cleanup_failed" });
});

test("storage deadlines release callers and late reads cannot start a timed-out save", async () => {
  const storage = storageFixture();
  let resolve;
  storage.get = () => new Promise((done) => { resolve = done; });
  const timers = [];
  const cache = cacheFor(storage, {
    setTimeoutImpl(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimeoutImpl() {},
  });
  const pending = cache.save(source, "保存しない訳");
  await waitFor(() => resolve);
  assert.equal(timers[0].ms, 5000);
  timers[0].callback();
  assert.deepEqual(await pending, { saved: false, error: "cache_write_failed" });
  resolve({});
  await flush();
  assert.deepEqual(storage.data, {});
});

test("worker lookups validate trust and input, never translate, and recreate from shared storage", async () => {
  const storage = storageFixture();
  const worker = workerFixture(storage);
  const completed = await worker.request({ type: "translate", ...source }).result;
  assert.deepEqual(completed.cache, { saved: true, error: null });
  assert.equal(worker.calls, 1);
  const recreated = workerFixture(storage);
  assert.deepEqual(await recreated.lookup(lookupMessage()), { status: "hit", text: completed.text, error: null });
  assert.equal(recreated.calls, 0);
  for (const sender of [{ ...recreated.sender, frameId: 1 }, { ...recreated.sender, url: "https://other.example" }]) {
    assert.equal((await recreated.lookup(lookupMessage(), sender)).error, "invalid_sender");
  }
  for (const message of [lookupMessage({ ...source, messageId: "bad" }), { ...lookupMessage(), extra: true },
    lookupMessage({ ...source, text: " " }), lookupMessage({ ...source, text: "x".repeat(8001) })]) {
    assert.equal((await recreated.lookup(message)).error, "invalid_input");
  }
  assert.equal(recreated.calls, 0);
});

test("worker saves only completed active receive requests; draft, failed stream and detached callers stay memory-only", async () => {
  const storage = storageFixture();
  const worker = workerFixture(storage);
  const draft = await worker.request({ type: "translateDraft", text: source.text }).result;
  assert.deepEqual(draft, { type: "result", text: `訳:${source.text}` });
  assert.deepEqual(storage.data, {});
  await worker.request({ type: "translateDraft", text: source.text }).result;
  assert.equal(worker.calls, 1);

  let complete;
  const pendingStorage = storageFixture();
  const pending = workerFixture(pendingStorage, { requestImpl: async (_tab, _payload, options) => {
    options.onChunk({ choices: [{ delta: { content: "途中" } }] });
    await new Promise((resolve) => { complete = resolve; });
    options.onChunk({ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] });
    options.onChunk({ choices: [], usage: { total_tokens: 1 } });
    return { status: 200 };
  } });
  const first = pending.request({ type: "translate", ...source });
  const second = pending.request({ type: "translate", ...source, messageId: "chat-messages-1-3" });
  await waitFor(() => second.port.messages.some((value) => value.type === "progress"));
  assert.deepEqual(pendingStorage.data, {});
  first.port.disconnect();
  complete();
  assert.equal((await second.result).text, "途中訳");
  assert.equal(pending.calls, 1);
  assert.equal((await pending.lookup(lookupMessage())).status, "miss");
  assert.equal((await pending.lookup(lookupMessage({ ...source, messageId: "chat-messages-1-3" }))).status, "hit");

  const failureStorage = storageFixture();
  const failed = workerFixture(failureStorage, { requestImpl: async (_tab, _payload, options) => {
    options.onChunk({ choices: [{ delta: { content: "途中" }, finish_reason: "length" }] });
    return { status: 200 };
  } });
  const result = await failed.request({ type: "translate", ...source }).result;
  assert.equal(result.error, "invalid_response");
  assert.deepEqual(failureStorage.data, {});
});
