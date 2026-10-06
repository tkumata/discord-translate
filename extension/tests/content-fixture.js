import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { storageFixture } from "./storage-fixture.js";

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

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export async function loadContentScript(onMessage = () => Promise.resolve({ ok: true, text: "訳文" }), options = {}) {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const observers = [];
  const document = options.document ?? new FakeDocument();
  const calls = [];
  const ports = [];
  const lookups = [];
  const changes = [];
  const chrome = {
    storage: {
      local: options.storage ?? storageFixture({ enabled: false }),
      onChanged: { addListener(listener) { changes.push(listener); } },
    },
    runtime: {
      sendMessage(message, callback) {
        lookups.push(message);
        const result = options.lookup ? options.lookup(structuredClone(message)) : { status: "miss", error: null };
        if (result?.then) result.then(callback, () => callback({ status: "miss", error: "cache_read_failed" }));
        else callback(result);
      },
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
            const response = onMessage(structuredClone(message));
            if (response !== undefined) {
              Promise.resolve(response).then((value) => {
                this.receive(value.ok ? { type: "result", text: value.text, ...(value.cache ? { cache: value.cache } : {}) } :
                  { type: "error", error: value.error });
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
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
      observe(target, settings) { this.target = target; this.settings = settings; this.active = true; }
      disconnect() { this.active = false; }
    },
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    location: { protocol: "https:", hostname: "discord.com", pathname: "/channels/1/2" },
    InputEvent: FakeInputEvent,
    DataTransfer: FakeDataTransfer,
    StaticRange: class { constructor(options) { Object.assign(this, options); } },
  };
  context.window = {};
  context.window.top = context.window;
  vm.createContext(context);
  for (const file of manifest.content_scripts[0].js) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  await flush();
  return {
    ...context, context, document, calls, ports, lookups, changes, observers,
    setEnabled(value) {
      for (const listener of changes) listener({ enabled: { newValue: value } }, "local");
    },
    mutate() { for (const observer of observers) if (observer.active) observer.callback([]); },
  };
}

export function message(document, id, text) {
  const container = document.createElement("li");
  container.id = id;
  const content = document.createElement("div");
  content.id = `message-content-${id.slice(id.lastIndexOf("-") + 1)}`;
  content.textContent = text;
  container.appendChild(content);
  document.body.appendChild(container);
  return { container, content };
}

export function ui(container, state) {
  return container
    .querySelectorAll("[data-discord-translate]")
    .find((element) => state === undefined || element.dataset.discordTranslate === state);
}

export function composer(env, source, acceptsEdits = true) {
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

export function composerUi(form) { return ui(form, "composer"); }
export const flushComposer = () => new Promise((resolve) => setTimeout(resolve, 0));
