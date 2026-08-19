import test from "node:test";
import assert from "node:assert/strict";
import {
  API_URL,
  FETCH_TIMEOUT_MS,
  handleBridgeRequest,
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
  assert.equal(valid.payload.max_tokens, 1024);
  assert.equal(validateBridgeRequest({
    ...valid,
    payload: { ...valid.payload, max_tokens: 512 },
  }), false);
  assert.equal(validateBridgeRequest({ ...valid, url: API_URL }), false);
  assert.equal(validateBridgeRequest({ ...valid, payload: { ...valid.payload, method: "GET" } }), false);
  assert.equal(validateBridgeRequest({ ...valid, payload: { ...valid.payload, headers: {} } }), false);
  assert.equal(validateBridgeRequest({ ...valid, payload: { ...valid.payload, stream: true } }), false);
});

test("posts only to the fixed localhost endpoint and returns the JSON envelope", async () => {
  const target = port();
  const pending = new Set();
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
      return { status: 200, json: async () => ({ choices: [] }) };
    },
  });
  assert.deepEqual(target.messages, [
    { type: "result", jobId: "job-2", status: 200, payload: { choices: [] } },
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
  const timeoutRequest = handleBridgeRequest(timeoutTarget, message, new Set(), {
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
  await handleBridgeRequest(deniedTarget, message, new Set(), {
    fetchImpl: async () => { throw Object.assign(new Error(), { name: "NotAllowedError" }); },
  });
  assert.deepEqual(deniedTarget.messages, [
    { type: "error", jobId: "job-3", error: "lna_denied" },
  ]);

  const httpTarget = port();
  await handleBridgeRequest(httpTarget, message, new Set(), {
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
  await handleBridgeRequest(target, message, new Set(), {
    logger: capture.logger,
    fetchImpl: async () => ({
      status: 200,
      json: async () => { throw new Error("秘密の例外"); },
    }),
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

test("does not expose page message inputs", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../bridge.js", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /window\.postMessage/);
  assert.doesNotMatch(source, /window\.addEventListener\(["']message/);
});
