import test from "node:test";
import assert from "node:assert/strict";
import { TranslationQueue, sha256Hex } from "../translation-queue.js";
import { buildPayload } from "../translation-protocol.js";
import { BridgeRegistry } from "../bridge-registry.js";
import { handleBridgeRequest, validateBridgeRequest } from "../bridge.js";
import { createReceivedTranslationCache, RECEIVED_CACHE_PREFIX } from "../received-translation-cache.js";
import { mountPopup } from "../popup.js";
import { storageFixture, workerFixture, waitFor } from "./storage-fixture.js";
import { completePort, fakePort, responseFor } from "./worker-test-fixture.js";
import { loadContentScript, message, ui, composer, composerUi, flush } from "./content-fixture.js";

test("providers separate shared jobs and memory cache while retaining a single FIFO", async () => {
  const calls = [];
  let release;
  const queue = new TranslationQueue({ hashImpl: (value) => value, requestImpl: async (_tab, _payload, options) => {
    calls.push(options.provider);
    if (options.provider === "local") await new Promise((resolve) => { release = resolve; });
    return responseFor(options.provider, options);
  } });
  const local = queue.translate("same text", 1);
  await waitFor(() => calls.length === 1);
  const chatgpt = queue.translate("same text", 1, { provider: "chatgpt" });
  const duplicate = queue.translate(" same text ", 2, { provider: "chatgpt" });
  release();
  assert.equal(await local, "訳:local");
  assert.equal(await chatgpt, "訳:chatgpt");
  assert.equal(await duplicate, "訳:chatgpt");
  assert.deepEqual(calls, ["local", "chatgpt"]);
  assert.equal(await queue.translate("same text", 1), "訳:local");
  assert.equal(await queue.translate("same text", 1, { provider: "chatgpt" }), "訳:chatgpt");
  await assert.rejects(queue.translate("text", 1, { provider: "unknown" }), (value) => value.code === "invalid_input");
  assert.equal(calls.length, 2);
});

test("bridge routes ChatGPT only to the fixed helper and maps account/usage errors", async () => {
  const bridge = fakePort({ id: "extension-id", frameId: 1,
    url: "chrome-extension://extension-id/bridge.html", tab: { id: 1 } });
  const registry = new BridgeRegistry();
  registry.connect(bridge, "extension-id", "chrome-extension://extension-id/bridge.html");
  const request = registry.request(1, buildPayload("source"), { provider: "chatgpt" });
  assert.equal(bridge.messages[0].provider, "chatgpt");
  completePort(bridge);
  assert.equal((await request).status, 200);
  assert.equal(validateBridgeRequest({ type: "translate", jobId: "job", provider: "remote", payload: buildPayload("source") }), false);
  const results = [];
  await handleBridgeRequest({ postMessage: (value) => results.push(value) }, bridge.messages[0], new Map(), {
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8766/v1/chat/completions");
      assert.equal(options.headers["X-Discord-Translate"], "1");
      assert.deepEqual(JSON.parse(options.body), buildPayload("source"));
      return { status: 429 };
    },
  });
  assert.equal(results[0].status, 429);
  for (const [status, code] of [[401, "chatgpt_auth_required"], [403, "chatgpt_auth_required"], [429, "chatgpt_usage_limit"]]) {
    const queue = new TranslationQueue({ requestImpl: async () => ({ status }), logger: null });
    await assert.rejects(queue.translate("source", 1, { provider: "chatgpt" }), (value) => value.code === code);
    assert.equal(queue.cache.size, 0);
    await assert.rejects(queue.translate("source", 1), (value) => value.code === "http_error");
  }
});

test("received cache preserves legacy local keys and never restores another provider's translation", async () => {
  const storage = storageFixture();
  const source = { messageId: "chat-messages-1-2", text: "source" };
  const hash = await sha256Hex(JSON.stringify(["ja", source.text]));
  const localKey = `${RECEIVED_CACHE_PREFIX}${source.messageId}:${hash}`;
  const cache = createReceivedTranslationCache(storage, { hashImpl: sha256Hex });
  await cache.save(source, "ローカル訳");
  assert.equal(storage.data[localKey].text, "ローカル訳");
  assert.equal((await cache.lookup({ ...source, provider: "chatgpt" })).status, "miss");
  await cache.save({ ...source, provider: "chatgpt" }, "ChatGPT訳");
  const recreated = createReceivedTranslationCache(storage, { hashImpl: sha256Hex });
  assert.equal((await recreated.lookup(source)).text, "ローカル訳");
  assert.equal((await recreated.lookup({ ...source, provider: "chatgpt" })).text, "ChatGPT訳");
});

test("worker fixes the provider before queuing and saving, and lookups use the current selection", async () => {
  const storage = storageFixture();
  let release;
  const worker = workerFixture(storage, { requestImpl: async (_tab, _payload, options) => {
    if (options.provider === "local") await new Promise((resolve) => { release = resolve; });
    return responseFor(options.provider, options);
  } });
  const source = { messageId: "chat-messages-1-2", text: "source" };
  const first = worker.request({ type: "translate", ...source });
  await waitFor(() => worker.calls === 1);
  await storage.set({ provider: "chatgpt" });
  release();
  assert.equal((await first.result).text, "訳:local");
  assert.equal((await worker.lookup({ type: "lookupTranslation", ...source })).status, "miss");
  assert.equal((await worker.request({ type: "translate", ...source }).result).text, "訳:chatgpt");
  assert.equal((await worker.lookup({ type: "lookupTranslation", ...source })).text, "訳:chatgpt");
  await storage.set({ provider: "local" });
  assert.equal((await worker.lookup({ type: "lookupTranslation", ...source })).text, "訳:local");
});

test("provider changes discard old receive/draft results, retain the draft and relookup on enable", async () => {
  const env = await loadContentScript(() => undefined);
  const { container } = message(env.document, "chat-messages-1-2", "source");
  const draft = composer(env, "元の下書き");
  env.setEnabled(true);
  ui(container, "button").click();
  composerUi(draft.form).children[0].click();
  const oldPorts = env.ports.slice();
  for (const listener of env.changes) listener({ provider: { newValue: "chatgpt" }, enabled: { newValue: false } }, "local");
  assert.ok(oldPorts.every((port) => port.closed));
  oldPorts.forEach((port) => port.receive({ type: "result", text: "古い訳" }));
  await flush();
  assert.equal(draft.model.text, "元の下書き");
  assert.equal(ui(container), undefined);
  const lookupCount = env.lookups.length;
  env.setEnabled(true);
  assert.equal(env.lookups.length, lookupCount + 1);
  assert.equal(env.calls.length, 2);
  assert.equal(draft.model.text, "元の下書き");
});

function popupElement() {
  const element = new EventTarget();
  element.disabled = false;
  element.hidden = false;
  element.checked = false;
  element.value = "local";
  element.textContent = "";
  element.change = () => element.dispatchEvent(new Event("change"));
  element.click = () => { if (!element.disabled) element.dispatchEvent(new Event("click")); };
  return element;
}

test("receive and draft errors explain ChatGPT reauthentication and usage recovery", async () => {
  const env = await loadContentScript(() => undefined);
  const { container } = message(env.document, "chat-messages-1-2", "source");
  const draft = composer(env, "元の下書き");
  env.setEnabled(true);
  ui(container, "button").click();
  composerUi(draft.form).children[0].click();
  env.ports[0].receive({ type: "error", error: "chatgpt_auth_required" });
  env.ports[1].receive({ type: "error", error: "chatgpt_usage_limit" });
  await flush();
  assert.match(ui(container, "error").textContent, /ChatGPT に再接続/);
  assert.match(composerUi(draft.form).children[2].textContent, /ChatGPT の利用量を管理/);
  assert.equal(draft.model.text, "元の下書き");
});

test("popup changes provider while OFF, checks only that provider and opens only helper login URLs", async () => {
  const ids = ["enabled", "provider", "chatgpt", "account-status", "connect", "disconnect", "refresh", "status", "error-code"];
  const elements = Object.fromEntries(ids.map((id) => [id, popupElement()]));
  const storage = storageFixture();
  const tabs = [];
  let healthy = 0;
  let connected = false;
  let loginUrl = "http://127.0.0.1:8766/auth/login?state=synthetic";
  const paths = [];
  const companionRequest = async (path) => {
    paths.push(path);
    if (path === "/auth/start") return { url: loginUrl };
    if (path === "/auth/logout") { connected = false; return { connected: false, revoked: false }; }
    return { connected, account: "test@example.invalid", model: "model" };
  };
  mountPopup({ documentApi: { querySelector: (selector) => elements[selector.slice(1)] },
    chromeApi: { storage: { local: storage }, tabs: { create: async (value) => tabs.push(value) },
      runtime: { sendMessage: async (message) => {
        assert.deepEqual(message, { type: "startTranslationServer", provider: "local" });
        return { ok: true };
      } } },
    companionRequest, healthCheck: async () => { healthy++; return { ok: true }; } });
  const idle = () => waitFor(() => !elements.enabled.disabled);
  await idle();
  assert.equal(paths.length, 0);
  elements.enabled.checked = true; elements.enabled.change(); await idle();
  assert.equal(storage.data.enabled, true);
  assert.equal(healthy, 1);
  elements.provider.value = "chatgpt"; elements.provider.change(); await idle();
  assert.equal(storage.data.provider, "chatgpt");
  assert.equal(storage.data.enabled, false);
  assert.equal(elements.chatgpt.hidden, false);
  elements.enabled.checked = true; elements.enabled.change(); await idle();
  assert.equal(storage.data.enabled, false);
  assert.equal(elements.enabled.checked, false);
  connected = true;
  elements.enabled.checked = true; elements.enabled.change(); await idle();
  assert.equal(storage.data.enabled, true);
  assert.equal(healthy, 1);
  elements.connect.click(); await idle();
  assert.deepEqual(tabs, [{ url: loginUrl }]);
  loginUrl = "https://example.invalid/steal";
  elements.connect.click(); await idle();
  assert.equal(tabs.length, 1);
  elements.disconnect.click(); await idle();
  assert.equal(storage.data.enabled, false);
  assert.match(elements.status.textContent, /遠隔失効は未確認/);
});
