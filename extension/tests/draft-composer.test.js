import test from "node:test";
import assert from "node:assert/strict";
import { loadContentScript, flush, composer, composerUi, flushComposer } from "./content-fixture.js";

test("composer scans never request translation and reject empty, oversized, rich and composing drafts", async () => {
  const env = await loadContentScript(() => undefined);
  const c = composer(env, "日本語");
  env.setEnabled(true);
  env.mutate();
  assert.equal(c.form.querySelectorAll('[data-discord-translate="composer"]').length, 1);
  const [translate, restore] = composerUi(c.form).children;
  assert.equal(translate.type, "button");
  assert.equal(translate.textContent, "英語に翻訳");
  assert.equal(restore.hidden, true);
  assert.equal(env.calls.length, 0);
  for (const text of [" \n ", "x".repeat(8001)]) {
    c.edit(text);
    translate.click();
    assert.equal(translate.disabled, true);
  }
  c.edit("日本語");
  c.editor.dispatchEvent({ type: "compositionstart" });
  translate.click();
  assert.equal(env.calls.length, 0);
  c.editor.dispatchEvent({ type: "compositionend" });
  const mention = env.document.createElement("span");
  mention.setAttribute("contenteditable", "false");
  mention.textContent = "@user";
  c.editor.children[0].append(mention);
  env.mutate();
  translate.click();
  assert.equal(translate.disabled, true);
  assert.match(composerUi(c.form).children[2].textContent, /メンション/);
  assert.equal(env.calls.length, 0);
});

test("only the completed English draft updates editor state; restore recovers exact source after further edits", async () => {
  const env = await loadContentScript(() => undefined);
  const source = " 日本語\n\n改行 ";
  const c = composer(env, source);
  const attachment = env.document.createElement("div");
  attachment.textContent = "attachment";
  c.form.append(attachment);
  let submissions = 0;
  c.form.addEventListener("submit", () => { submissions++; });
  env.setEnabled(true);
  const [translate, restore] = composerUi(c.form).children;
  translate.click();
  translate.click();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].type, "translateDraft");
  assert.equal(env.calls[0].text, source.trim());
  assert.deepEqual(Object.keys(env.calls[0]).sort(), ["text", "type"]);
  env.ports[0].receive({ type: "progress", text: "Partial" });
  assert.equal(c.model.text, source);
  env.ports[0].receive({ type: "result", text: " English\n\n<b>literal</b> " });
  await flushComposer();
  assert.equal(c.model.text, "English\n\n<b>literal</b>");
  assert.equal(env.document.activeElement, c.editor);
  assert.equal(restore.hidden, false);
  c.edit("Edited English");
  restore.click();
  await flushComposer();
  assert.equal(c.model.text, source);
  assert.equal(restore.hidden, true);
  assert.equal(env.calls.length, 1);
  assert.equal(submissions, 0);
  assert.equal(attachment.isConnected, true);
  assert.equal(env.ports[0].closed, true);
});

test("draft edits, edit-revert, navigation, removal, replacement and OFF discard delayed results", async () => {
  for (const change of ["edit", "revert", "space", "navigate", "replace", "remove", "off"]) {
    const env = await loadContentScript(() => undefined);
    const c = composer(env, "元の日本語");
    env.setEnabled(true);
    composerUi(c.form).children[0].click();
    if (change === "edit") c.edit("新しい日本語");
    if (change === "revert") { c.edit("変更"); c.edit("元の日本語"); }
    if (change === "space") c.edit(" 元の日本語 ");
    if (change === "navigate") { env.location.pathname = "/channels/1/3"; env.mutate(); }
    if (change === "replace") {
      c.editor.replaceWith(env.document.createElement("div"));
      env.mutate();
    }
    if (change === "remove") { c.form.remove(); env.mutate(); }
    if (change === "off") env.setEnabled(false);
    assert.equal(env.ports[0].closed, true, change);
    const expected = c.model.text;
    env.ports[0].receive({ type: "progress", text: "Late" });
    env.ports[0].receive({ type: "result", text: "Late English" });
    await flush();
    assert.equal(c.model.text, expected, change);
  }
});

test("draft errors and absolute timeout keep source intact and allow manual retry", async () => {
  for (const failure of ["timeout", "disconnect", "malformed", "error"]) {
    const env = await loadContentScript(() => undefined);
    let timer;
    let cleared = false;
    env.context.setTimeout = (callback, ms) => { timer = { callback, ms }; return timer; };
    env.context.clearTimeout = () => { cleared = true; };
    const c = composer(env, "日本語");
    env.setEnabled(true);
    const translate = composerUi(c.form).children[0];
    translate.click();
    env.ports[0].receive({ type: "progress", text: "Partial" });
    assert.equal(timer.ms, 240_000);
    if (failure === "timeout") timer.callback();
    if (failure === "disconnect") env.ports[0].disconnect();
    if (failure === "malformed") env.ports[0].receive({ type: "result", text: "bad", extra: true });
    if (failure === "error") env.ports[0].receive({ type: "error", error: "http_error" });
    assert.equal(c.model.text, "日本語");
    assert.equal(translate.disabled, false);
    assert.match(composerUi(c.form).children[2].textContent, /翻訳できませんでした/);
    assert.equal(env.ports[0].closed, true);
    assert.equal(cleared, true);
    translate.click();
    assert.equal(env.calls.length, 2);
    env.setEnabled(false);
  }
});

test("restore keeps the previous snapshot after failed retranslation and expires on clearing or leaving a draft", async () => {
  for (const change of ["clear", "navigate", "off", "replace"]) {
    const env = await loadContentScript(() => undefined);
    const c = composer(env, "日本語");
    env.setEnabled(true);
    const [translate, restore] = composerUi(c.form).children;
    translate.click();
    env.ports[0].receive({ type: "result", text: "English" });
    await flushComposer();
    translate.click();
    assert.equal(restore.disabled, true);
    env.ports[1].receive({ type: "error", error: "request_timeout" });
    assert.equal(restore.disabled, false);
    if (change === "clear") c.edit("");
    if (change === "navigate") { env.location.pathname = "/channels/1/3"; env.mutate(); }
    if (change === "off") env.setEnabled(false);
    if (change === "replace") { c.editor.remove(); env.mutate(); }
    const expected = c.model.text;
    restore.click();
    await flush();
    assert.equal(c.model.text, expected);
    if (change === "clear") assert.equal(restore.hidden, true);
    else assert.equal(restore.isConnected, false);
  }
});

test("a successful subsequent translation restores its own preceding draft and an unhandled edit is reported", async () => {
  const env = await loadContentScript(() => undefined);
  const c = composer(env, "日本語");
  env.setEnabled(true);
  const [translate, restore] = composerUi(c.form).children;
  translate.click();
  env.ports[0].receive({ type: "result", text: "English" });
  await flushComposer();
  c.edit("編集した下書き");
  translate.click();
  env.ports[1].receive({ type: "result", text: "Updated English" });
  await flushComposer();
  restore.click();
  await flushComposer();
  assert.equal(c.model.text, "編集した下書き");

  const unhandled = composer(env, "変更しない日本語", false);
  env.mutate();
  composerUi(unhandled.form).children[0].click();
  env.ports[2].receive({ type: "result", text: "Unhandled English" });
  await flushComposer();
  assert.equal(unhandled.model.text, "変更しない日本語");
  assert.match(composerUi(unhandled.form).children[2].textContent, /下書きを更新できませんでした/);
  assert.equal(composerUi(unhandled.form).children[1].hidden, true);
});

test("only new-post forms on channel routes are eligible; Slate empty blocks and trailing LF are preserved", async () => {
  const env = await loadContentScript(() => undefined);
  const c = composer(env, "コード\n\n末尾");
  c.editor.children.at(-1).children[0].textContent = "末尾\n\n";
  env.setEnabled(true);
  composerUi(c.form).children[0].click();
  assert.equal(env.calls[0].text, "コード\n\n末尾");
  env.setEnabled(false);
  env.location.pathname = "/channels/@me/3";
  env.setEnabled(true);
  assert.ok(composerUi(c.form));
  env.setEnabled(false);
  c.form.setAttribute("role", "dialog");
  env.setEnabled(true);
  assert.equal(composerUi(c.form), undefined);
  env.setEnabled(false);
});
