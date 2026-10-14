import test from "node:test";
import assert from "node:assert/strict";
import { createNativeHelper, NATIVE_HOST_NAMES } from "../chatgpt-native.js";
import { registerChromeListeners } from "../service-worker.js";
import { requestCompanion, mountPopup } from "../popup.js";
import { fakePort } from "./worker-test-fixture.js";
import { storageFixture, waitFor } from "./storage-fixture.js";

function nativeRuntime() {
  const ports = [];
  const runtime = {
    connectNative(name) {
      const port = fakePort();
      port.hostName = name;
      ports.push(port);
      return port;
    },
  };
  return { runtime, ports };
}

test("native startup shares one connection, waits for ready and reconnects only on demand", async () => {
  const { runtime, ports } = nativeRuntime();
  const start = createNativeHelper(runtime);
  const first = start("chatgpt");
  assert.equal(start("chatgpt"), first);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].hostName, NATIVE_HOST_NAMES.chatgpt);
  ports[0].receive({ type: "ready" });
  assert.deepEqual(await first, { ok: true });
  ports[0].disconnect();
  assert.equal(ports.length, 1);
  const retry = start("chatgpt");
  assert.equal(ports.length, 2);
  ports[1].disconnect();
  assert.deepEqual(await retry, { ok: false });
});

test("invalid native responses, missing hosts and startup timeout fail without a restart loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { runtime, ports } = nativeRuntime();
  const start = createNativeHelper(runtime);
  const invalid = start("chatgpt");
  ports[0].receive({ type: "ready", tokens: "not allowed" });
  assert.deepEqual(await invalid, { ok: false });
  assert.equal(ports[0].disconnected, true);
  const timeout = start("chatgpt");
  t.mock.timers.tick(15_000);
  assert.deepEqual(await timeout, { ok: false });
  assert.equal(ports[1].disconnected, true);
  assert.equal(ports.length, 2);
  assert.deepEqual(await createNativeHelper({ connectNative() { throw new Error("missing"); } })("local"), { ok: false });
});

test("switching provider closes the old connection and cancels its pending readiness", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { runtime, ports } = nativeRuntime();
  const start = createNativeHelper(runtime);
  const local = start("local");
  assert.equal(ports[0].hostName, NATIVE_HOST_NAMES.local);
  t.mock.timers.tick(15_000);
  assert.equal(ports[0].disconnected, false);
  const chatgpt = start("chatgpt");
  assert.equal(ports[0].disconnected, true);
  assert.deepEqual(await local, { ok: false });
  ports[0].receive({ type: "ready" });
  ports[1].receive({ type: "ready" });
  assert.deepEqual(await chatgpt, { ok: true });
  const retryLocal = start("local");
  assert.equal(ports[1].disconnected, true);
  t.mock.timers.tick(130_000);
  assert.deepEqual(await retryLocal, { ok: false });
  assert.equal(ports.length, 3);
  assert.throws(() => start("invalid"));
  assert.equal(ports.length, 3);
});

test("worker starts on load/startup and allows only popup to request startup readiness", async () => {
  const { runtime, ports } = nativeRuntime();
  runtime.id = "extension-id";
  runtime.getURL = (path) => `chrome-extension://extension-id/${path}`;
  let onMessage;
  let onStartup;
  let onChanged;
  runtime.onConnect = { addListener() {} };
  runtime.onMessage = { addListener(listener) { onMessage = listener; } };
  runtime.onStartup = { addListener(listener) { onStartup = listener; } };
  const storage = storageFixture();
  registerChromeListeners({ runtime, storage: { local: storage,
    onChanged: { addListener(listener) { onChanged = listener; } } } });
  await waitFor(() => ports.length === 1);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].hostName, NATIVE_HOST_NAMES.local);
  const message = { type: "startTranslationServer", provider: "local" };
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
  await Promise.resolve();
  assert.equal(ports.length, 1);
  await storage.set({ provider: "chatgpt" });
  onChanged({ provider: { newValue: "chatgpt" } }, "local");
  await waitFor(() => ports.length === 2);
  assert.equal(ports[0].disconnected, true);
  assert.equal(ports[1].hostName, NATIVE_HOST_NAMES.chatgpt);
  assert.deepEqual(await new Promise((resolve) => onMessage(message, popup, resolve)), { ok: false });
  assert.equal(ports.length, 2);
  ports[1].receive({ type: "ready" });
  onChanged({ enabled: { newValue: false } }, "local");
  assert.equal(ports[1].disconnected, false);
  ports[1].disconnect();
});

test("popup waits for native readiness before HTTP and refuses a failed startup", async (t) => {
  let resolve;
  const started = new Promise((done) => { resolve = done; });
  const original = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: async (message) => {
    assert.deepEqual(message, { type: "startTranslationServer", provider: "chatgpt" });
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

test("a stale startup read cannot restart the provider selected before a switch", async () => {
  const { runtime, ports } = nativeRuntime();
  const storage = storageFixture({ provider: "chatgpt" });
  const get = storage.get;
  let release;
  let onChanged;
  storage.get = (keys) => {
    if (keys?.provider && !release) return new Promise((resolve) => { release = resolve; });
    return get(keys);
  };
  runtime.onConnect = { addListener() {} };
  runtime.onMessage = { addListener() {} };
  registerChromeListeners({ runtime, storage: { local: storage,
    onChanged: { addListener(listener) { onChanged = listener; } } } });
  onChanged({ provider: { newValue: "chatgpt" } }, "local");
  await waitFor(() => ports.length === 1);
  assert.equal(ports[0].hostName, NATIVE_HOST_NAMES.chatgpt);
  ports[0].receive({ type: "ready" });
  release({ provider: "local" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ports.length, 1);
  assert.equal(ports[0].disconnected, false);
  ports[0].disconnect();
});

test("local enable waits for Native readiness before browser health and stays OFF on startup failure", async () => {
  const elements = Object.fromEntries(["enabled", "status", "error-code"].map((id) => [id, new EventTarget()]));
  const storage = storageFixture();
  let release;
  let healthy = 0;
  let allowStart = true;
  mountPopup({ documentApi: { querySelector: (selector) => elements[selector.slice(1)] },
    chromeApi: { storage: { local: storage }, runtime: { sendMessage: (message) => {
      assert.deepEqual(message, { type: "startTranslationServer", provider: "local" });
      return new Promise((resolve) => { release = () => resolve({ ok: allowStart }); });
    } } }, healthCheck: async () => { healthy++; return { ok: true }; } });
  await waitFor(() => !elements.enabled.disabled);
  elements.enabled.checked = true;
  elements.enabled.dispatchEvent(new Event("change"));
  assert.equal(healthy, 0);
  assert.equal(storage.data.enabled, undefined);
  release();
  await waitFor(() => !elements.enabled.disabled);
  assert.equal(healthy, 1);
  assert.equal(storage.data.enabled, true);
  allowStart = false;
  elements.enabled.dispatchEvent(new Event("change"));
  release();
  await waitFor(() => !elements.enabled.disabled);
  assert.equal(healthy, 1);
  assert.equal(storage.data.enabled, false);
  assert.match(elements["error-code"].textContent, /local_unavailable/);
});
