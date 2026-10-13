import test from "node:test";
import assert from "node:assert/strict";
import { loadContentScript, message, ui, flush } from "./content-fixture.js";
import { createReceivedTranslationCache } from "../received-translation-cache.js";
import { sha256Hex } from "../translation-queue.js";
import { storageFixture, workerFixture, waitFor } from "./storage-fixture.js";

test("scan only renders one button per message and sends nothing", async () => {
  const env = await loadContentScript();
  const first = message(env.document, "chat-messages-1-1", "hello");
  const second = message(env.document, "chat-messages-1-2", "world");

  env.setEnabled(true);
  env.mutate();

  assert.equal(env.calls.length, 0);
  assert.equal(first.container.querySelectorAll('[data-discord-translate="button"]').length, 1);
  assert.equal(second.container.querySelectorAll('[data-discord-translate="button"]').length, 1);
  assert.equal(env.document.querySelectorAll('[data-discord-translate="button"]').length, 2);
});

test("reply preview before current content selects the current message", async () => {
  const env = await loadContentScript(() => Promise.resolve({ ok: true, text: "現在の訳" }));
  const container = env.document.createElement("li");
  container.id = "chat-messages-10-20";
  const replyPreview = env.document.createElement("div");
  replyPreview.id = "message-content-10";
  replyPreview.textContent = "返信先の本文";
  const content = env.document.createElement("div");
  content.id = "message-content-20";
  content.textContent = "現在の本文";
  container.append(replyPreview, content);
  env.document.body.appendChild(container);

  env.setEnabled(true);

  assert.equal(container.querySelectorAll('[data-discord-translate="button"]').length, 1);
  assert.equal(content.parentNode.children.indexOf(ui(container, "button")), content.parentNode.children.indexOf(content) + 1);
  ui(container, "button").click();
  await flush();

  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].type, "translate");
  assert.equal(env.calls[0].messageId, container.id);
  assert.equal(env.calls[0].text, "現在の本文");
});

test("one click sends one request and disables the button while pending", async () => {
  let resolve;
  const env = await loadContentScript(() => new Promise((result) => { resolve = result; }));
  const { container } = message(env.document, "chat-messages-2-1", "hello");
  env.setEnabled(true);
  const button = ui(container, "button");

  button.click();
  button.click();

  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].type, "translate");
  assert.equal(env.calls[0].messageId, "chat-messages-2-1");
  assert.equal(env.calls[0].text, "hello");
  assert.equal(ui(container, "loading").textContent, "翻訳中…");
  assert.equal(ui(container, "loading").disabled, true);
  resolve({ ok: true, text: "こんにちは" });
  await flush();
});

test("success keeps the source and renders a Japanese translation directly below it", async () => {
  const env = await loadContentScript(() => Promise.resolve({ ok: true, text: "こんにちは <b>世界</b>\n改行" }));
  const { container, content } = message(env.document, "chat-messages-3-1", "hello");
  env.setEnabled(true);
  ui(container, "button").click();
  await flush();

  const translation = ui(container, "translation");
  const [label, body] = translation.children;
  assert.equal(content.textContent, "hello");
  assert.equal(label.className, "discord-translate-translation-label");
  assert.equal(label.textContent, "日本語訳");
  assert.equal(body.className, "discord-translate-translation-body");
  assert.equal(body.textContent, "こんにちは <b>世界</b>\n改行");
  assert.equal(translation.lang, "ja");
  assert.equal(content.parentNode.children.indexOf(translation), content.parentNode.children.indexOf(content) + 1);
});

test("failure shows a fixed code and retry sends the next request", async () => {
  let attempts = 0;
  const env = await loadContentScript(() => {
    attempts += 1;
    return attempts === 1
      ? Promise.resolve({ ok: false, error: "http_error" })
      : Promise.resolve({ ok: true, text: "再試行成功" });
  });
  const { container } = message(env.document, "chat-messages-4-1", "hello");
  env.setEnabled(true);
  ui(container, "button").click();
  await flush();

  const error = ui(container, "error");
  assert.match(error.textContent, /翻訳できませんでした（http_error）/);
  error.children.find((element) => element.tagName === "BUTTON").click();
  await flush();
  assert.equal(env.calls.length, 2);
  assert.equal(ui(container, "translation").children[1].textContent, "再試行成功");
});

test("changed text invalidates a pending result and returns to a new button", async () => {
  let resolve;
  const env = await loadContentScript(() => new Promise((result) => { resolve = result; }));
  const { container, content } = message(env.document, "chat-messages-6-1", "old");
  env.setEnabled(true);
  ui(container, "button").click();
  content.textContent = "new";
  env.mutate();
  resolve({ ok: true, text: "古い訳" });
  await flush();

  assert.equal(ui(container, "button").textContent, "翻訳");
  assert.equal(ui(container, "translation"), undefined);
});

test("replaced content node invalidates the old result and removes old UI", async () => {
  let resolve;
  const env = await loadContentScript(() => new Promise((result) => { resolve = result; }));
  const { container, content } = message(env.document, "chat-messages-7-1", "old");
  env.setEnabled(true);
  ui(container, "button").click();
  const replacement = env.document.createElement("div");
  replacement.id = "message-content-1";
  replacement.textContent = "new";
  content.replaceWith(replacement);
  env.mutate();
  resolve({ ok: true, text: "古い訳" });
  await flush();

  assert.equal(container.querySelectorAll('[data-discord-translate="button"]').length, 1);
  assert.equal(container.querySelectorAll('[data-discord-translate="translation"]').length, 0);
});

test("progress updates one body before completion, preserves whitespace and clears partial failures", async () => {
  const env = await loadContentScript(() => undefined);
  const { container, content } = message(env.document, "chat-messages-8-1", "source");
  env.setEnabled(true);
  ui(container, "button").click();
  const port = env.ports[0];
  port.receive({ type: "progress", text: " 訳\n" });
  const translation = ui(container, "translation");
  const body = translation.children[1];
  assert.equal(translation.children[0].textContent, "日本語訳（翻訳中…）");
  assert.equal(translation.children[0].attributes.get("aria-live"), "polite");
  assert.equal(body.textContent, " 訳\n");
  port.receive({ type: "progress", text: " 訳\n続き" });
  assert.equal(ui(container, "translation"), translation);
  assert.equal(translation.children[1], body);
  port.receive({ type: "result", text: " 訳\n続き " });
  assert.equal(translation.children[0].textContent, "日本語訳");
  assert.equal(body.textContent, "訳\n続き");
  assert.equal(port.closed, true);
  assert.equal(content.textContent, "source");

  const next = message(env.document, "chat-messages-8-2", "other");
  env.mutate();
  ui(next.container, "button").click();
  env.ports[1].receive({ type: "progress", text: "部分" });
  env.ports[1].receive({ type: "error", error: "request_timeout" });
  assert.equal(ui(next.container, "translation"), undefined);
  assert.match(ui(next.container, "error").textContent, /request_timeout/);
  ui(next.container, "error").children[1].click();
  assert.equal(env.calls.length, 3);
});

test("progress restores a translation block whose body was removed", async () => {
  const env = await loadContentScript(() => undefined);
  const { container, content } = message(env.document, "chat-messages-8-3", "source");
  env.setEnabled(true);
  ui(container, "button").click();
  const port = env.ports[0];
  port.receive({ type: "progress", text: "途中" });
  ui(container, "translation").children[1].remove();
  port.receive({ type: "result", text: "完成訳" });
  const translation = ui(container, "translation");
  assert.equal(container.querySelectorAll('[data-discord-translate="translation"]').length, 1);
  assert.equal(translation.children[0].textContent, "日本語訳");
  assert.equal(translation.children[1].textContent, "完成訳");
  assert.equal(content.textContent, "source");
  assert.equal(port.closed, true);
});

test("OFF, editing, DOM replacement and removal close progress subscriptions and discard late events", async () => {
  for (const change of ["off", "edit", "replace", "remove"]) {
    const env = await loadContentScript(() => undefined);
    const { container, content } = message(env.document, "chat-messages-9-1", "source");
    env.setEnabled(true);
    ui(container, "button").click();
    const port = env.ports[0];
    port.receive({ type: "progress", text: "部分" });
    if (change === "off") env.setEnabled(false);
    if (change === "edit") { content.textContent = "new"; env.mutate(); }
    if (change === "replace") {
      const replacement = env.document.createElement("div");
      replacement.id = content.id;
      replacement.textContent = "new";
      content.replaceWith(replacement);
      env.mutate();
    }
    if (change === "remove") { container.remove(); env.mutate(); }
    assert.equal(port.closed, true);
    port.receive({ type: "progress", text: "古い部分" });
    port.receive({ type: "result", text: "古い完成訳" });
    assert.equal(env.document.querySelectorAll('[data-discord-translate="translation"]').length, 0);
    if (change === "edit" || change === "replace") assert.equal(ui(container, "button").textContent, "翻訳");
  }
});

test("unexpected disconnect or malformed progress removes partial output and permits retry", async () => {
  for (const failure of ["disconnect", "malformed"]) {
    const env = await loadContentScript(() => undefined);
    const { container } = message(env.document, "chat-messages-10-1", "source");
    env.setEnabled(true);
    ui(container, "button").click();
    env.ports[0].receive({ type: "progress", text: "部分" });
    if (failure === "disconnect") env.ports[0].disconnect();
    else env.ports[0].receive({ type: "progress", text: "bad", extra: true });
    assert.equal(ui(container, "translation"), undefined);
    assert.match(ui(container, "error").textContent, failure === "disconnect" ? /network_error/ : /invalid_response/);
    assert.equal(env.ports[0].closed, true);
  }
});

test("the content deadline is absolute and releases a partial subscription", async () => {
  const env = await loadContentScript(() => undefined);
  let timer;
  let cleared = false;
  env.context.setTimeout = (callback, ms) => { timer = { callback, ms }; return timer; };
  env.context.clearTimeout = () => { cleared = true; };
  const { container } = message(env.document, "chat-messages-11-1", "source");
  env.setEnabled(true);
  ui(container, "button").click();
  const original = timer;
  env.ports[0].receive({ type: "progress", text: "部分" });
  assert.equal(timer, original);
  assert.equal(timer.ms, 240_000);
  timer.callback();
  assert.equal(ui(container, "translation"), undefined);
  assert.match(ui(container, "error").textContent, /request_timeout/);
  assert.equal(env.ports[0].closed, true);
  assert.equal(cleared, true);
});

test("saved receive translations restore after navigation, page and worker recreation without a translation POST", async () => {
  let now = 100;
  const storage = storageFixture({ enabled: true });
  const createWorker = () => workerFixture(storage, { cache:
    createReceivedTranslationCache(storage, { hashImpl: sha256Hex, now: () => now }) });
  const firstWorker = createWorker();
  const first = await loadContentScript(async (payload) => {
    const response = await firstWorker.request(payload).result;
    return { ok: response.type === "result", ...response };
  }, { storage, lookup: (payload) => firstWorker.lookup(payload) });
  const original = message(first.document, "chat-messages-1-2", "source");
  first.setEnabled(true);
  await waitFor(() => ui(original.container, "button")?.disabled === false);
  ui(original.container, "button").click();
  await waitFor(() => ui(original.container, "translation")?.children[0].textContent === "日本語訳");
  assert.equal(ui(original.container, "translation").children[1].textContent, "訳:source");
  assert.equal(firstWorker.calls, 1);
  const deadline = Object.values(storage.data).find((value) => value?.version === 1).expiresAt;

  original.container.remove();
  first.mutate();
  const returnView = message(first.document, "chat-messages-1-2", "source");
  first.mutate();
  await waitFor(() => ui(returnView.container, "translation"));
  assert.equal(ui(returnView.container, "translation").children[1].textContent, "訳:source");
  assert.equal(firstWorker.calls, 1);
  first.setEnabled(false);

  const recreatedWorker = createWorker();
  const restored = await loadContentScript(() => { throw new Error("must not translate on restore"); },
    { storage, document: first.document, lookup: (payload) => recreatedWorker.lookup(payload) });
  await waitFor(() => ui(returnView.container, "translation"));
  assert.equal(ui(returnView.container, "translation").children[0].textContent, "日本語訳");
  assert.equal(restored.calls.length, 0);
  assert.equal(recreatedWorker.calls, 0);
  restored.changes[0]({ enabled: { newValue: false } }, "local");
  assert.equal(ui(returnView.container, "translation"), undefined);
  restored.changes[0]({ enabled: { newValue: true } }, "local");
  await waitFor(() => ui(returnView.container, "translation"));
  assert.equal(ui(returnView.container, "translation").lang, "ja");
  assert.equal(Object.values(storage.data).find((value) => value?.version === 1).expiresAt, deadline);
  ui(returnView.container, "translation").remove();
  restored.mutate();
  await waitFor(() => ui(returnView.container, "translation"));
  assert.equal(returnView.container.querySelectorAll('[data-discord-translate="translation"]').length, 1);
  now = deadline;
  restored.setEnabled(false);
  restored.setEnabled(true);
  await waitFor(() => ui(returnView.container, "button")?.disabled === false);
  assert.equal(ui(returnView.container, "translation"), undefined);
  assert.equal(ui(returnView.container, "button").disabled, false);
  assert.equal(recreatedWorker.calls, 0);
});

test("receive lookups reject edited text, same-text other messages and reply previews", async () => {
  const storage = storageFixture();
  const worker = workerFixture(storage);
  await worker.request({ type: "translate", messageId: "chat-messages-1-2", text: "source" }).result;
  const env = await loadContentScript(undefined, { lookup: (payload) => worker.lookup(payload) });
  const edited = message(env.document, "chat-messages-1-2", "edited");
  const other = message(env.document, "chat-messages-1-3", "source");
  const reply = env.document.createElement("div");
  reply.id = "message-content-2";
  reply.textContent = "source";
  other.container.children.unshift(reply);
  reply.parentNode = other.container;
  env.setEnabled(true);
  await flush();
  assert.equal(ui(edited.container, "translation"), undefined);
  assert.equal(ui(other.container, "translation"), undefined);
  assert.deepEqual(env.lookups.map((payload) => payload.messageId), ["chat-messages-1-2", "chat-messages-1-3"]);
  assert.equal(env.calls.length, 0);
  assert.equal(worker.calls, 1);
});

test("late lookups are discarded on OFF, edit, DOM replacement, removal and message identity changes", async () => {
  for (const change of ["off", "edit", "replace", "remove", "id", "invalid-id"]) {
    const pending = [];
    const env = await loadContentScript(undefined, { lookup: () => new Promise((resolve) => pending.push(resolve)) });
    const { container, content } = message(env.document, "chat-messages-1-2", "source");
    env.setEnabled(true);
    env.mutate();
    assert.equal(env.lookups.length, 1);
    assert.equal(ui(container, "button").disabled, true);
    if (change === "off") env.setEnabled(false);
    if (change === "edit") content.textContent = "edited";
    if (change === "replace") {
      const replacement = env.document.createElement("div");
      replacement.id = content.id;
      replacement.textContent = "source";
      content.replaceWith(replacement);
    }
    if (change === "remove") container.remove();
    if (change === "id") container.id = "chat-messages-3-2";
    if (change === "invalid-id") container.id = "unrelated";
    env.mutate();
    pending[0]({ status: "hit", text: "古い訳", error: null });
    await flush();
    assert.equal(ui(container, "translation"), undefined, change);
    assert.equal(env.calls.length, 0);
    if (change === "invalid-id") assert.equal(ui(container), undefined);
    env.setEnabled(false);
  }
});

test("completed translations are removed when a reused container changes identity", async () => {
  const env = await loadContentScript(undefined, { lookup: () => ({ status: "hit", text: "訳", error: null }) });
  const { container } = message(env.document, "chat-messages-1-2", "source");
  env.setEnabled(true);
  assert.ok(ui(container, "translation"));
  container.id = "unrelated";
  env.mutate();
  assert.equal(ui(container), undefined);
});

test("new messages log automatic cache read failures without showing errors or translating", async () => {
  for (const failure of [
    { lookup: () => ({ status: "miss", error: "cache_read_failed" }) },
    { lookup: () => undefined },
    { lookup: () => ({ status: "hit", text: "private translation", error: null, extra: "private details" }) },
    { lookup: () => { throw new Error("private details"); } },
    { runtimeError: { message: "private details" } },
  ]) {
    const env = await loadContentScript(undefined, failure);
    const warnings = [];
    env.context.console = { warn: (...args) => warnings.push(args) };
    env.setEnabled(true);
    env.context.chrome.runtime.lastError = failure.runtimeError;
    const { container, content } = message(env.document, "chat-messages-1-2", "private source");
    env.mutate();
    env.mutate();
    assert.equal(env.lookups.length, 1);
    assert.equal(env.calls.length, 0);
    assert.equal(ui(container, "cache-warning"), undefined);
    assert.equal(ui(container, "error"), undefined);
    assert.equal(ui(container, "translation"), undefined);
    assert.equal(ui(container, "button").textContent, "翻訳");
    assert.equal(ui(container, "button").disabled, false);
    assert.equal(content.textContent, "private source");
    assert.deepEqual(warnings, [["cache_read_failed"]]);
    env.setEnabled(false);
  }
});

test("storage read failures and timeout allow manual translation; write failures retain the completed text", async () => {
  const env = await loadContentScript(() => ({ ok: true, text: "完成訳", cache: { saved: false, error: "cache_write_failed" } }),
    { lookup: () => ({ status: "miss", error: "cache_read_failed" }) });
  const { container, content } = message(env.document, "chat-messages-1-2", "source");
  env.setEnabled(true);
  assert.equal(ui(container, "cache-warning"), undefined);
  ui(container, "button").click();
  await flush();
  assert.equal(ui(container, "translation").children[1].textContent, "完成訳");
  assert.match(ui(container, "cache-warning").textContent, /翻訳文を保存できませんでした（cache_write_failed）/);
  assert.equal(container.querySelectorAll('[data-discord-translate="cache-warning"]').length, 1);
  assert.equal(content.textContent, "source");
  assert.equal(ui(container, "error"), undefined);

  const pending = await loadContentScript(undefined, { lookup: () => new Promise(() => {}) });
  const warnings = [];
  pending.context.console = { warn: (...args) => warnings.push(args) };
  let timer;
  pending.context.setTimeout = (callback, ms) => { timer = { callback, ms }; return timer; };
  pending.context.clearTimeout = () => {};
  const next = message(pending.document, "chat-messages-1-2", "source");
  pending.setEnabled(true);
  assert.equal(timer.ms, 5000);
  timer.callback();
  assert.equal(ui(next.container, "cache-warning"), undefined);
  assert.deepEqual(warnings, [["cache_read_failed"]]);
  assert.equal(ui(next.container, "button").disabled, false);
  assert.equal(pending.calls.length, 0);
  pending.setEnabled(false);
});

test("malformed cache responses never render and corrupted result metadata keeps retry available", async () => {
  const env = await loadContentScript(() => undefined, { lookup: () => ({ status: "hit", text: "bad", error: null, extra: true }) });
  const { container } = message(env.document, "chat-messages-1-2", "source");
  env.setEnabled(true);
  assert.equal(ui(container, "translation"), undefined);
  assert.equal(ui(container, "cache-warning"), undefined);
  ui(container, "button").click();
  env.ports[0].receive({ type: "result", text: "bad", cache: { saved: true, error: "private details" } });
  assert.equal(ui(container, "translation"), undefined);
  assert.match(ui(container, "error").textContent, /invalid_response/);
});
