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
  const chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: (message) => {
        calls.push(message);
        return onMessage(message);
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
  return { ...context, document, calls, api: context.__testApi };
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
  const source = await readFile(new URL("../content-script.js", import.meta.url), "utf8");
  assert.match(source, /data-discord-translate-bridge/);
  assert.match(source, /chrome\.runtime\.getURL\("bridge\.html"\)/);
  assert.match(source, /setAttribute\("hidden", ""\)/);
  assert.match(source, /setAttribute\("aria-hidden", "true"\)/);
  assert.match(source, /setAttribute\("tabindex", "-1"\)/);
  assert.match(source, /if \(bridge\?\.isConnected\) return/);
  assert.match(source, /stopBridge\(\);/);
  assert.doesNotMatch(source, /window\.postMessage/);
  assert.doesNotMatch(source, /addEventListener\(["']message/);
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
