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

  addEventListener(type, listener) {
    if (type === "click") this.clickListener = listener;
  }

  click() {
    if (!this.disabled) this.clickListener?.({ currentTarget: this });
  }

  matches(selector) {
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
