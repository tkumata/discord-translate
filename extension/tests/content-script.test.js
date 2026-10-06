import test from "node:test";
import assert from "node:assert/strict";
import { loadContentScript, message, ui, flush } from "./content-fixture.js";

test("creates one fixed hidden bridge iframe and removes it when disabled", async () => {
  const env = await loadContentScript();
  env.setEnabled(true);
  env.setEnabled(true);
  const frames = env.document.querySelectorAll('iframe[data-discord-translate-bridge="true"]');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, "chrome-extension://test/bridge.html");
  assert.equal(frames[0].attributes.get("hidden"), "");
  assert.equal(frames[0].attributes.get("aria-hidden"), "true");
  assert.equal(frames[0].attributes.get("tabindex"), "-1");
  assert.equal(env.calls.length, 0);
  env.setEnabled(false);
  assert.equal(env.document.querySelectorAll('iframe[data-discord-translate-bridge="true"]').length, 0);
});

test("OFF removes observer, bridge, and UI without sending a request", async () => {
  let resolve;
  const env = await loadContentScript(() => new Promise((result) => { resolve = result; }));
  const { container } = message(env.document, "chat-messages-5-1", "hello");
  env.setEnabled(true);
  ui(container, "button").click();
  env.setEnabled(false);
  assert.equal(env.observers.every((observer) => !observer.active), true);
  message(env.document, "chat-messages-5-2", "after OFF");
  env.mutate();
  resolve({ ok: true, text: "表示しない" });
  await flush();

  assert.equal(env.calls.length, 1);
  assert.equal(env.document.querySelectorAll('[data-discord-translate="button"]').length, 0);
  assert.equal(env.document.querySelectorAll('[data-discord-translate="loading"]').length, 0);
  assert.equal(env.lookups.length, 1);
  assert.equal(env.document.querySelectorAll('iframe[data-discord-translate-bridge="true"]').length, 0);
});
