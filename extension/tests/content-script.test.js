import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class FakeElement {
  constructor(tagName, ownerDocument = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this._textContent = "";
    this.disabled = false;
    this.listeners = new Map();
  }

  get isConnected() {
    return this.parentNode ? this.parentNode.isConnected : this.ownerDocument === this;
  }

  get textContent() {
    return this.children.length > 0
      ? this.children.map((child) => child.textContent).join("")
      : this._textContent;
  }

  set textContent(value) {
    this.children = [];
    this._textContent = String(value);
  }

  appendChild(child) {
    child.remove();
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument ?? this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  after(element) {
    const index = this.parentNode.children.indexOf(this);
    element.remove();
    element.parentNode = this.parentNode;
    element.ownerDocument = this.ownerDocument;
    this.parentNode.children.splice(index + 1, 0, element);
  }

  replaceWith(element) {
    const index = this.parentNode.children.indexOf(this);
    element.remove();
    element.parentNode = this.parentNode;
    element.ownerDocument = this.ownerDocument;
    this.parentNode.children.splice(index, 1, element);
    this.parentNode = null;
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "data-discord-translate") this.dataset.discordTranslate = String(value);
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  focus() { this.ownerDocument.activeElement = this; }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }

  click() {
    if (!this.disabled) this.dispatchEvent({ type: "click", currentTarget: this });
  }

  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
    if (selector === "form") return this.tagName === "FORM";
    if (selector === 'img' || selector === 'svg') return this.tagName === selector.toUpperCase();
    if (selector === '[role="textbox"][contenteditable="true"][data-slate-editor="true"]') {
      return this.getAttribute("role") === "textbox" && this.getAttribute("contenteditable") === "true" &&
        this.getAttribute("data-slate-editor") === "true";
    }
    const attribute = selector.match(/^\[([\w-]+)(?:="([^"]+)")?\]$/);
    if (attribute && attribute[1] !== "data-discord-translate") {
      return attribute[2] === undefined ? this.hasAttribute(attribute[1]) : this.getAttribute(attribute[1]) === attribute[2];
    }
    if (selector === 'li[id^="chat-messages-"]') {
      return this.tagName === "LI" && this.id?.startsWith("chat-messages-");
    }
    if (selector === '[id^="message-content-"]') {
      return this.id?.startsWith("message-content-");
    }
    if (selector === 'iframe[data-discord-translate-bridge="true"]') {
      return this.tagName === "IFRAME" && this.attributes.get("data-discord-translate-bridge") === "true";
    }
    if (selector === "[data-discord-translate]") return this.dataset.discordTranslate !== undefined;
    const stateMatch = selector.match(/^\[data-discord-translate="([^"]+)"\]$/);
    if (stateMatch) return this.dataset.discordTranslate === stateMatch[1];
    return false;
  }

  closest(selector) {
    let element = this;
    while (element) {
      if (element.matches(selector)) return element;
      element = element.parentNode;
    }
    return null;
  }

  contains(element) {
    return element === this || this.children.some((child) => child.contains(element));
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super("#document");
    this.ownerDocument = this;
    this.body = new FakeElement("body", this);
    this.appendChild(this.body);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createRange() {
    return {
      selectNodeContents(element) {
        this.startContainer = this.endContainer = element;
        this.startOffset = 0;
        this.endOffset = element.children.length;
      },
    };
  }

  getSelection() {
    return { removeAllRanges() {}, addRange(range) { this.range = range; } };
  }
}

class FakeInputEvent {
  constructor(type, options) { this.type = type; Object.assign(this, options); }
  getTargetRanges() { return this.targetRanges; }
  preventDefault() { this.defaultPrevented = true; }
}

class FakeDataTransfer {
  constructor() { this.data = new Map(); }
  setData(type, value) { this.data.set(type, value); }
  getData(type) { return this.data.get(type) ?? ""; }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
  }

  observe(target, options) {
    this.target = target;
    this.options = options;
  }

  disconnect() {
    this.disconnected = true;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function loadContentScript(onMessage = () => Promise.resolve({ ok: true, text: "訳文" })) {
  const source = await readFile(new URL("../content-script.js", import.meta.url), "utf8");
  const document = new FakeDocument();
  const calls = [];
  const ports = [];
  const chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      connect: ({ name }) => {
        assert.equal(name, "discord-translate-request");
        const messages = [];
        const disconnects = [];
        const port = {
          closed: false,
          onMessage: { addListener(listener) { messages.push(listener); } },
          onDisconnect: { addListener(listener) { disconnects.push(listener); } },
          receive(message) { for (const listener of messages) listener(message); },
          disconnect() {
            if (this.closed) return;
            this.closed = true;
            for (const listener of disconnects) listener();
          },
          postMessage(message) {
            calls.push(message);
            const response = onMessage(message);
            if (response !== undefined) {
              Promise.resolve(response).then((value) => {
                this.receive(value.ok ? { type: "result", text: value.text } : { type: "error", error: value.error });
              });
            }
          },
        };
        ports.push(port);
        return port;
      },
    },
  };
  const context = {
    document,
    chrome,
    Element: FakeElement,
    HTMLElement: FakeElement,
    MutationObserver: FakeMutationObserver,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    location: { pathname: "/channels/1/2" },
    InputEvent: FakeInputEvent,
    DataTransfer: FakeDataTransfer,
    StaticRange: class { constructor(options) { Object.assign(this, options); } },
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.__testApi = { applyEnabled, scan, processContainer, requestTranslation };`,
    context,
  );
  return { ...context, context, document, calls, ports, api: context.__testApi };
}

function message(document, id, text) {
  const container = document.createElement("li");
  container.id = id;
  const content = document.createElement("div");
  content.id = `message-content-${id.slice(id.lastIndexOf("-") + 1)}`;
  content.textContent = text;
  container.appendChild(content);
  document.body.appendChild(container);
  return { container, content };
}

function ui(container, state) {
  return container
    .querySelectorAll("[data-discord-translate]")
    .find((element) => state === undefined || element.dataset.discordTranslate === state);
}

test("creates one fixed hidden bridge iframe and removes it when disabled", async () => {
  const env = await loadContentScript();
  env.api.applyEnabled(true);
  env.api.applyEnabled(true);
  const frames = env.document.querySelectorAll('iframe[data-discord-translate-bridge="true"]');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, "chrome-extension://test/bridge.html");
  assert.equal(frames[0].attributes.get("hidden"), "");
  assert.equal(frames[0].attributes.get("aria-hidden"), "true");
  assert.equal(frames[0].attributes.get("tabindex"), "-1");
  assert.equal(env.calls.length, 0);
  env.api.applyEnabled(false);
  assert.equal(env.document.querySelectorAll('iframe[data-discord-translate-bridge="true"]').length, 0);
});

test("scan only renders one button per message and sends nothing", async () => {
  const env = await loadContentScript();
  const first = message(env.document, "chat-messages-1-1", "hello");
  const second = message(env.document, "chat-messages-1-2", "world");

  env.api.applyEnabled(true);
  env.api.scan();

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

  env.api.applyEnabled(true);

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
  env.api.applyEnabled(true);
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
  env.api.applyEnabled(true);
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
  env.api.applyEnabled(true);
  ui(container, "button").click();
  await flush();

  const error = ui(container, "error");
  assert.match(error.textContent, /翻訳できませんでした（http_error）/);
  error.children.find((element) => element.tagName === "BUTTON").click();
  await flush();
  assert.equal(env.calls.length, 2);
  assert.equal(ui(container, "translation").children[1].textContent, "再試行成功");
});

test("OFF removes observer, bridge, and UI without sending a request", async () => {
  let resolve;
  const env = await loadContentScript(() => new Promise((result) => { resolve = result; }));
  const { container } = message(env.document, "chat-messages-5-1", "hello");
  env.api.applyEnabled(true);
  ui(container, "button").click();
  env.api.applyEnabled(false);
  resolve({ ok: true, text: "表示しない" });
  await flush();

  assert.equal(env.calls.length, 1);
  assert.equal(env.document.querySelectorAll('[data-discord-translate="button"]').length, 0);
  assert.equal(env.document.querySelectorAll('[data-discord-translate="loading"]').length, 0);
  assert.equal(env.document.querySelectorAll('iframe[data-discord-translate-bridge="true"]').length, 0);
});

test("changed text invalidates a pending result and returns to a new button", async () => {
  let resolve;
  const env = await loadContentScript(() => new Promise((result) => { resolve = result; }));
  const { container, content } = message(env.document, "chat-messages-6-1", "old");
  env.api.applyEnabled(true);
  ui(container, "button").click();
  content.textContent = "new";
  env.api.scan();
  resolve({ ok: true, text: "古い訳" });
  await flush();

  assert.equal(ui(container, "button").textContent, "翻訳");
  assert.equal(ui(container, "translation"), undefined);
});

test("replaced content node invalidates the old result and removes old UI", async () => {
  let resolve;
  const env = await loadContentScript(() => new Promise((result) => { resolve = result; }));
  const { container, content } = message(env.document, "chat-messages-7-1", "old");
  env.api.applyEnabled(true);
  ui(container, "button").click();
  const replacement = env.document.createElement("div");
  replacement.id = "message-content-1";
  replacement.textContent = "new";
  content.replaceWith(replacement);
  env.api.scan();
  resolve({ ok: true, text: "古い訳" });
  await flush();

  assert.equal(container.querySelectorAll('[data-discord-translate="button"]').length, 1);
  assert.equal(container.querySelectorAll('[data-discord-translate="translation"]').length, 0);
});

test("progress updates one body before completion, preserves whitespace and clears partial failures", async () => {
  const env = await loadContentScript(() => undefined);
  const { container, content } = message(env.document, "chat-messages-8-1", "source");
  env.api.applyEnabled(true);
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
  env.api.scan();
  ui(next.container, "button").click();
  env.ports[1].receive({ type: "progress", text: "部分" });
  env.ports[1].receive({ type: "error", error: "request_timeout" });
  assert.equal(ui(next.container, "translation"), undefined);
  assert.match(ui(next.container, "error").textContent, /request_timeout/);
  ui(next.container, "error").children[1].click();
  assert.equal(env.calls.length, 3);
});

test("OFF, editing, DOM replacement and removal close progress subscriptions and discard late events", async () => {
  for (const change of ["off", "edit", "replace", "remove"]) {
    const env = await loadContentScript(() => undefined);
    const { container, content } = message(env.document, "chat-messages-9-1", "source");
    env.api.applyEnabled(true);
    ui(container, "button").click();
    const port = env.ports[0];
    port.receive({ type: "progress", text: "部分" });
    if (change === "off") env.api.applyEnabled(false);
    if (change === "edit") { content.textContent = "new"; env.api.scan(); }
    if (change === "replace") {
      const replacement = env.document.createElement("div");
      replacement.id = content.id;
      replacement.textContent = "new";
      content.replaceWith(replacement);
      env.api.scan();
    }
    if (change === "remove") { container.remove(); env.api.scan(); }
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
    env.api.applyEnabled(true);
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
  env.api.applyEnabled(true);
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

function composer(env, source, acceptsEdits = true) {
  const { document } = env;
  const form = document.createElement("form");
  const editor = document.createElement("div");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("data-slate-editor", "true");
  const model = { text: source };
  const render = (text) => {
    model.text = text;
    editor.textContent = "";
    for (const line of text.split("\n")) {
      const block = document.createElement("div");
      block.setAttribute("data-slate-node", "element");
      const leaf = document.createElement("span");
      leaf.setAttribute(line ? "data-slate-string" : "data-slate-zero-width", line ? "" : "n");
      leaf.textContent = line || "\uFEFF";
      block.append(leaf);
      editor.append(block);
    }
  };
  render(source);
  editor.addEventListener("beforeinput", (event) => {
    if (!acceptsEdits || event.inputType !== "insertFromPaste") return;
    const range = event.getTargetRanges()[0];
    assert.equal(range.startContainer, editor);
    assert.equal(range.startOffset, 0);
    assert.equal(range.endContainer, editor);
    assert.equal(range.endOffset, editor.children.length);
    event.preventDefault();
    render(event.dataTransfer.getData("text/plain"));
  });
  form.append(editor);
  document.body.append(form);
  return { form, editor, model, render, edit(text) { render(text); editor.dispatchEvent({ type: "input" }); } };
}

function composerUi(form) { return ui(form, "composer"); }
const flushComposer = () => new Promise((resolve) => setTimeout(resolve, 0));

test("composer scans never request translation and reject empty, oversized, rich and composing drafts", async () => {
  const env = await loadContentScript(() => undefined);
  const c = composer(env, "日本語");
  env.api.applyEnabled(true);
  env.api.scan();
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
  env.api.scan();
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
  env.api.applyEnabled(true);
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
    env.api.applyEnabled(true);
    composerUi(c.form).children[0].click();
    if (change === "edit") c.edit("新しい日本語");
    if (change === "revert") { c.edit("変更"); c.edit("元の日本語"); }
    if (change === "space") c.edit(" 元の日本語 ");
    if (change === "navigate") { env.location.pathname = "/channels/1/3"; env.api.scan(); }
    if (change === "replace") {
      c.editor.replaceWith(env.document.createElement("div"));
      env.api.scan();
    }
    if (change === "remove") { c.form.remove(); env.api.scan(); }
    if (change === "off") env.api.applyEnabled(false);
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
    env.api.applyEnabled(true);
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
    env.api.applyEnabled(false);
  }
});

test("restore keeps the previous snapshot after failed retranslation and expires on clearing or leaving a draft", async () => {
  for (const change of ["clear", "navigate", "off", "replace"]) {
    const env = await loadContentScript(() => undefined);
    const c = composer(env, "日本語");
    env.api.applyEnabled(true);
    const [translate, restore] = composerUi(c.form).children;
    translate.click();
    env.ports[0].receive({ type: "result", text: "English" });
    await flushComposer();
    translate.click();
    assert.equal(restore.disabled, true);
    env.ports[1].receive({ type: "error", error: "request_timeout" });
    assert.equal(restore.disabled, false);
    if (change === "clear") c.edit("");
    if (change === "navigate") { env.location.pathname = "/channels/1/3"; env.api.scan(); }
    if (change === "off") env.api.applyEnabled(false);
    if (change === "replace") { c.editor.remove(); env.api.scan(); }
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
  env.api.applyEnabled(true);
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
  env.api.scan();
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
  env.api.applyEnabled(true);
  composerUi(c.form).children[0].click();
  assert.equal(env.calls[0].text, "コード\n\n末尾");
  env.api.applyEnabled(false);
  env.location.pathname = "/channels/@me/3";
  env.api.applyEnabled(true);
  assert.ok(composerUi(c.form));
  env.api.applyEnabled(false);
  c.form.setAttribute("role", "dialog");
  env.api.applyEnabled(true);
  assert.equal(composerUi(c.form), undefined);
  env.api.applyEnabled(false);
});
