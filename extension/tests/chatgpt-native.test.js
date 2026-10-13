import test from "node:test";
import assert from "node:assert/strict";
import { createNativeHelper, NATIVE_HOST_NAME } from "../chatgpt-native.js";
import { registerChromeListeners } from "../service-worker.js";
import { requestCompanion } from "../popup.js";
import { fakePort } from "./worker-test-fixture.js";
import { storageFixture } from "./storage-fixture.js";

function nativeRuntime() {
  const ports = [];
  const runtime = {
    connectNative(name) {
      assert.equal(name, NATIVE_HOST_NAME);
      const port = fakePort();
      ports.push(port);
      return port;
    },
  };
  return { runtime, ports };
}

test("native startup shares one connection, waits for ready and reconnects only on demand", async () => {
  const { runtime, ports } = nativeRuntime();
  const start = createNativeHelper(runtime);
  const first = start();
  assert.equal(start(), first);
  assert.equal(ports.length, 1);
  ports[0].receive({ type: "ready" });
  assert.deepEqual(await first, { ok: true });
  ports[0].disconnect();
  assert.equal(ports.length, 1);
  const retry = start();
  assert.equal(ports.length, 2);
  ports[1].disconnect();
  assert.deepEqual(await retry, { ok: false });
});

test("invalid native responses, missing hosts and startup timeout fail without a restart loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { runtime, ports } = nativeRuntime();
  const start = createNativeHelper(runtime);
  const invalid = start();
  ports[0].receive({ type: "ready", tokens: "not allowed" });
  assert.deepEqual(await invalid, { ok: false });
  assert.equal(ports[0].disconnected, true);
  const timeout = start();
  t.mock.timers.tick(15_000);
  assert.deepEqual(await timeout, { ok: false });
  assert.equal(ports[1].disconnected, true);
  assert.equal(ports.length, 2);
  assert.deepEqual(await createNativeHelper({ connectNative() { throw new Error("missing"); } })(), { ok: false });
});

test("worker starts on load/startup and allows only popup to request startup readiness", async () => {
  const { runtime, ports } = nativeRuntime();
  runtime.id = "extension-id";
  runtime.getURL = (path) => `chrome-extension://extension-id/${path}`;
  let onMessage;
  let onStartup;
  runtime.onConnect = { addListener() {} };
  runtime.onMessage = { addListener(listener) { onMessage = listener; } };
  runtime.onStartup = { addListener(listener) { onStartup = listener; } };
  registerChromeListeners({ runtime, storage: { local: storageFixture() } });
  assert.equal(ports.length, 1);
  const message = { type: "startChatGPTHelper" };
  const popup = { id: runtime.id, url: runtime.getURL("popup.html") };
  for (const sender of [
    { ...popup, id: "other" }, { ...popup, url: "https://discord.com/" }, { ...popup, tab: { id: 1 } },
  ]) {
    let state;
    assert.equal(onMessage(message, sender, (value) => { state = value; }), false);
    assert.deepEqual(state, { ok: false });
  }
  const ready = new Promise((resolve) => { assert.equal(onMessage(message, popup, resolve), true); });
  ports[0].receive({ type: "ready" });
  assert.deepEqual(await ready, { ok: true });
  onStartup();
  assert.equal(ports.length, 1);
});

test("popup waits for native readiness before HTTP and refuses a failed startup", async (t) => {
  let resolve;
  const started = new Promise((done) => { resolve = done; });
  const original = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: async (message) => {
    assert.deepEqual(message, { type: "startChatGPTHelper" });
    return started;
  } } };
  t.after(() => { if (original === undefined) delete globalThis.chrome; else globalThis.chrome = original; });
  let requests = 0;
  const fetchImpl = async () => { requests++; return { status: 200, json: async () => ({ connected: false }) }; };
  const request = requestCompanion("/status", "GET", fetchImpl);
  assert.equal(requests, 0);
  resolve({ ok: true });
  assert.deepEqual(await request, { connected: false });
  assert.equal(requests, 1);
  globalThis.chrome.runtime.sendMessage = async () => ({ ok: false });
  await assert.rejects(requestCompanion("/status", "GET", fetchImpl), /chatgpt_unavailable/);
  assert.equal(requests, 1);
});
