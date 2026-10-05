import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_TIMEOUT_MS,
  checkHealth,
  disableTranslation,
  enableTranslation,
} from "../popup.js";

function response(status, payload) {
  return {
    status,
    async json() {
      return payload;
    },
  };
}

test("accepts only the exact healthy response and fixed URL", async () => {
  const calls = [];
  const result = await checkHealth({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { status: "ok" });
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8080/health");
  assert.equal(calls[0].options.method, "GET");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("rejects HTTP and schema failures without enabling translation", async () => {
  for (const [fetchImpl, code] of [
    [async () => response(503, { status: "ok" }), "health_http_error"],
    [async () => response(200, { status: "ok", extra: true }), "health_invalid_response"],
    [async () => response(200, { status: "ready" }), "health_invalid_response"],
    [async () => ({ status: 200, async json() { throw new Error("invalid JSON"); } }), "health_invalid_response"],
    [async () => ({ status: 200 }), "health_http_error"],
  ]) {
    const result = await checkHealth({ fetchImpl });
    assert.deepEqual(result, { ok: false, error: code });
  }

  const stored = [];
  const result = await enableTranslation({
    healthCheck: async () => ({ ok: false, error: "health_http_error" }),
    setEnabled: async (enabled) => stored.push(enabled),
  });
  assert.deepEqual(result, { enabled: false, error: "health_http_error" });
  assert.deepEqual(stored, [false]);
});

test("maps network and LNA rejection to fixed codes", async () => {
  assert.deepEqual(
    await checkHealth({ fetchImpl: async () => { throw Object.assign(new Error(), { name: "NotAllowedError" }); } }),
    { ok: false, error: "lna_denied" },
  );
  assert.deepEqual(
    await checkHealth({ fetchImpl: async () => { throw new Error("network"); } }),
    { ok: false, error: "health_network_error" },
  );
});

test("aborts health request at the fixed timeout", async () => {
  let timer;
  const request = checkHealth({
    setTimeoutImpl(callback, ms) { timer = { callback, ms }; return timer; },
    clearTimeoutImpl(value) { if (value === timer) timer.cleared = true; },
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  assert.equal(timer.ms, HEALTH_TIMEOUT_MS);
  timer.callback();
  assert.deepEqual(await request, { ok: false, error: "health_timeout" });
  assert.equal(timer.cleared, true);
});

test("stores true only after health success and disables without health", async () => {
  const stored = [];
  let healthCalls = 0;
  const enabled = await enableTranslation({
    healthCheck: async () => {
      healthCalls += 1;
      return { ok: true };
    },
    setEnabled: async (value) => stored.push(value),
  });
  assert.deepEqual(enabled, { enabled: true, error: null });
  assert.equal(healthCalls, 1);

  const disabled = await disableTranslation({ setEnabled: async (value) => stored.push(value) });
  assert.deepEqual(disabled, { enabled: false });
  assert.deepEqual(stored, [true, false]);
});
