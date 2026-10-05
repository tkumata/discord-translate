const MESSAGE_CONTAINER_SELECTOR = 'li[id^="chat-messages-"]';
const MESSAGE_CONTENT_SELECTOR = '[id^="message-content-"]';
const MESSAGE_ID_PATTERN = /^chat-messages-[0-9]+-[0-9]+$/;
const CONTENT_ID_PATTERN = /^message-content-[0-9]+$/;
const MAX_TEXT_LENGTH = 8000;
const COMPOSER_SELECTOR = '[role="textbox"][contenteditable="true"][data-slate-editor="true"]';
const BRIDGE_SELECTOR = 'iframe[data-discord-translate-bridge="true"]';
const TRANSLATION_ERROR_CODES = new Set([
  "invalid_sender",
  "invalid_input",
  "hash_error",
  "queue_full",
  "queue_timeout",
  "request_timeout",
  "lna_denied",
  "bridge_unavailable",
  "network_error",
  "http_error",
  "invalid_response",
]);

let enabled = false;
let observer = null;
let records = new WeakMap();
let bridge = null;
const activeRequests = new Set();
const composers = new Map();

function isDiscordTopFrame() {
  return (
    typeof window !== "undefined" &&
    window.top === window &&
    location.protocol === "https:" &&
    location.hostname === "discord.com"
  );
}

function createBridgeElement() {
  const element = document.createElement("iframe");
  element.setAttribute("data-discord-translate-bridge", "true");
  element.setAttribute("hidden", "");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("tabindex", "-1");
  element.src = chrome.runtime.getURL("bridge.html");
  return element;
}

function startBridge() {
  if (bridge?.isConnected) return;
  const source = chrome.runtime.getURL("bridge.html");
  const candidates = [...document.querySelectorAll(BRIDGE_SELECTOR)].filter((element) => element.src === source);
  bridge = candidates[0] ?? null;
  for (const candidate of candidates.slice(1)) candidate.remove();
  if (!bridge) {
    bridge = createBridgeElement();
    document.body.appendChild(bridge);
  }
}

function stopBridge() {
  bridge?.remove();
  const source = chrome.runtime.getURL("bridge.html");
  for (const candidate of document.querySelectorAll(BRIDGE_SELECTOR)) {
    if (candidate.src === source) candidate.remove();
  }
  bridge = null;
}

function validContainer(container) {
  return container instanceof HTMLElement && MESSAGE_ID_PATTERN.test(container.id);
}

function findMessageContent(container) {
  const messageId = container.id.slice(container.id.lastIndexOf("-") + 1);
  const currentContentId = `message-content-${messageId}`;
  for (const content of container.querySelectorAll(MESSAGE_CONTENT_SELECTOR)) {
    if (!CONTENT_ID_PATTERN.test(content.id)) continue;
    if (content.id !== currentContentId) continue;
    if (content.closest(MESSAGE_CONTAINER_SELECTOR) === container) return content;
  }
  return null;
}

function normalizedContent(content) {
  const text = content.textContent?.trim() ?? "";
  return text.length > 0 && text.length <= MAX_TEXT_LENGTH ? text : null;
}

function removeRecordUi(record) {
  if (record?.ui?.isConnected) record.ui.remove();
  if (record) record.ui = null;
}

function removeContainerUi(container) {
  for (const element of container.querySelectorAll("[data-discord-translate]")) element.remove();
}

function removeAllUi() {
  for (const element of document.querySelectorAll("[data-discord-translate]")) element.remove();
}

function currentRecord(content, container, record) {
  return (
    enabled &&
    records.get(content) === record &&
    container.isConnected &&
    content.isConnected &&
    container.contains(content) &&
    content.textContent.trim() === record.text
  );
}

function showLoading(content, record) {
  removeRecordUi(record);
  const element = document.createElement("button");
  element.type = "button";
  element.disabled = true;
  element.dataset.discordTranslate = "loading";
  element.className = "discord-translate-loading";
  element.textContent = "翻訳中…";
  element.setAttribute("aria-live", "polite");
  content.after(element);
  record.ui = element;
}

function showButton(content, container, record) {
  removeRecordUi(record);
  const element = document.createElement("button");
  element.type = "button";
  element.dataset.discordTranslate = "button";
  element.className = "discord-translate-button";
  element.textContent = "翻訳";
  element.addEventListener("click", () => requestTranslation(content, container));
  content.after(element);
  record.ui = element;
}

function showTranslation(content, record, translation, pending = false) {
  if (record.ui?.dataset.discordTranslate === "translation") {
    record.ui.children[0].textContent = pending ? "日本語訳（翻訳中…）" : "日本語訳";
    record.ui.children[1].textContent = translation;
    return;
  }
  removeRecordUi(record);
  const element = document.createElement("div");
  element.dataset.discordTranslate = "translation";
  element.className = "discord-translate-translation";
  element.lang = "ja";
  const label = document.createElement("span");
  label.className = "discord-translate-translation-label";
  label.textContent = pending ? "日本語訳（翻訳中…）" : "日本語訳";
  label.setAttribute("role", "status");
  label.setAttribute("aria-live", "polite");
  const body = document.createElement("div");
  body.className = "discord-translate-translation-body";
  body.textContent = translation;
  element.append(label, body);
  content.after(element);
  record.ui = element;
}

function showFailure(content, container, record, errorCode) {
  removeRecordUi(record);
  const element = document.createElement("div");
  element.dataset.discordTranslate = "error";
  element.className = "discord-translate-error";

  const message = document.createElement("span");
  message.textContent = `翻訳できませんでした（${errorCode}）`;
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "再試行";
  retry.addEventListener("click", () => requestTranslation(content, container, true));

  element.append(message, retry);
  content.after(element);
  record.ui = element;
}

function fixedErrorCode(response) {
  return TRANSLATION_ERROR_CODES.has(response?.error) ? response.error : "network_error";
}

function openTranslationRequest(payload, receive, fail) {
  let port;
  let timeout;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    port?.disconnect();
  };
  const failure = (code) => {
    close();
    fail(code);
  };
  try {
    port = chrome.runtime.connect({ name: "discord-translate-request" });
    port.onMessage.addListener((message) => {
      if (closed) return;
      const keys = message && typeof message === "object" ? Object.keys(message).sort().join(",") : "";
      if ((message?.type === "progress" || message?.type === "result") && keys === "text,type" &&
          typeof message.text === "string" && message.text.length > 0 && message.text.length <= 64 * 1024 &&
          (message.type === "progress" || message.text.trim())) {
        if (message.type === "result") close();
        receive(message);
      } else if (message?.type === "error" && keys === "error,type") {
        failure(fixedErrorCode(message));
      } else {
        failure("invalid_response");
      }
    });
    port.onDisconnect.addListener(() => { if (!closed) failure("network_error"); });
    timeout = setTimeout(() => failure("request_timeout"), 240_000);
    timeout?.unref?.();
    port.postMessage(payload);
  } catch {
    failure("network_error");
  }
  return close;
}

function requestTranslation(content, container, retry = false) {
  if (!enabled || !container.isConnected || !content.isConnected) return;
  const text = normalizedContent(content);
  if (!text) return;

  const previous = records.get(content);
  if (!previous || previous.text !== text || previous.container !== container) return;
  if (!retry && previous.state !== "idle") return;
  if (retry && previous.state !== "failed") return;

  const record = {
    container,
    content,
    text,
    state: "pending",
    ui: null,
  };
  records.set(content, record);
  showLoading(content, record);

  const finish = () => {
    record.close?.();
    activeRequests.delete(record);
  };
  activeRequests.add(record);
  const fail = (code) => {
    finish();
    if (!currentRecord(content, container, record)) return;
    record.state = "failed";
    showFailure(content, container, record, code);
  };
  const receive = (message) => {
    if (!currentRecord(content, container, record)) {
      finish();
      removeRecordUi(record);
      if (records.get(content) === record) records.delete(content);
      return;
    }
    if (message.type === "progress") {
      showTranslation(content, record, message.text, true);
    } else {
      finish();
      record.state = "succeeded";
      showTranslation(content, record, message.text.trim());
    }
  };
  const close = openTranslationRequest({ type: "translate", messageId: container.id, text }, receive, fail);
  record.close = () => { close(); activeRequests.delete(record); };
}

function composerText(editor) {
  if (editor.querySelectorAll('[contenteditable="false"], [data-slate-void], [data-slate-inline], img, svg').length) {
    return null;
  }
  const blocks = [...editor.children];
  if (!blocks.length || blocks.some((block) => block.getAttribute("data-slate-node") !== "element")) return null;
  const lines = [];
  for (const block of blocks) {
    const leaves = [...block.querySelectorAll("[data-slate-string], [data-slate-zero-width]")];
    if (!leaves.length) return null;
    lines.push(leaves.map((leaf, index) => {
      if (leaf.hasAttribute("data-slate-zero-width")) return "";
      // Slate renders an extra trailing LF to keep a final line break visible.
      const text = leaf.textContent;
      return index === leaves.length - 1 && text.endsWith("\n\n") ? text.slice(0, -1) : text;
    }).join(""));
  }
  return lines.join("\n");
}

function currentComposer(record) {
  return enabled && composers.get(record.editor) === record && record.editor.isConnected &&
    record.editor.closest("form") === record.form && location.pathname === record.path;
}

function cancelComposerRequest(record) {
  record.close?.();
  record.close = null;
  record.pending = false;
}

function refreshComposer(record) {
  const text = composerText(record.editor);
  record.text = text;
  if (text !== null && !text.trim()) record.original = null;
  const reason = text === null ? "メンションなどを含む下書きは翻訳できません。" :
    text.trim().length > MAX_TEXT_LENGTH ? "下書きは8,000文字以内にしてください。" : "";
  const label = record.pending ? "翻訳中…" : "英語に翻訳";
  if (record.translateButton.textContent !== label) record.translateButton.textContent = label;
  record.translateButton.disabled = record.pending || record.applying || record.composing ||
    text === null || !text.trim() || text.trim().length > MAX_TEXT_LENGTH;
  record.restoreButton.hidden = record.original === null;
  record.restoreButton.disabled = record.pending || record.applying || record.composing || text === null;
  const status = reason || record.status;
  if (record.statusElement.textContent !== status) record.statusElement.textContent = status;
}

function disposeComposer(record) {
  cancelComposerRequest(record);
  for (const [type, listener] of record.listeners) record.editor.removeEventListener(type, listener, true);
  record.original = null;
  record.ui.remove();
  composers.delete(record.editor);
}

function composerEdited(record) {
  if (record.applying) return;
  record.generation++;
  cancelComposerRequest(record);
  record.status = "";
  refreshComposer(record);
}

async function replaceComposerText(record, text) {
  if (!currentComposer(record) || record.composing || composerText(record.editor) === null) return false;
  record.applying = true;
  refreshComposer(record);
  try {
    record.editor.focus();
    const range = document.createRange();
    range.selectNodeContents(record.editor);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const data = new DataTransfer();
    data.setData("text/plain", text);
    record.editor.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true, cancelable: true, composed: true,
      inputType: "insertFromPaste", dataTransfer: data,
      targetRanges: [new StaticRange({
        startContainer: range.startContainer, startOffset: range.startOffset,
        endContainer: range.endContainer, endOffset: range.endOffset,
      })],
    }));
    // Yield to the editor's state update without waiting for a visible-tab animation frame.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return currentComposer(record) && composerText(record.editor) === text;
  } catch {
    return false;
  } finally {
    record.applying = false;
    record.generation++;
  }
}

async function restoreComposer(record) {
  if (!currentComposer(record) || record.pending || record.applying || record.composing || record.original === null) return;
  const restored = await replaceComposerText(record, record.original);
  if (!currentComposer(record)) return;
  record.status = restored ? "翻訳前の下書きに戻しました。" : "下書きを更新できませんでした。";
  if (restored) record.original = null;
  refreshComposer(record);
}

function requestDraftTranslation(record) {
  if (!currentComposer(record) || record.pending || record.applying || record.composing) return;
  const source = composerText(record.editor);
  if (source === null || !source.trim() || source.trim().length > MAX_TEXT_LENGTH) return;
  const generation = record.generation;
  const isCurrent = () => currentComposer(record) && record.generation === generation &&
    composerText(record.editor) === source;
  record.pending = true;
  record.status = "";
  refreshComposer(record);
  const fail = (code) => {
    if (!isCurrent()) return;
    cancelComposerRequest(record);
    record.status = `翻訳できませんでした（${code}）`;
    refreshComposer(record);
  };
  record.close = openTranslationRequest({ type: "translateDraft", text: source.trim() }, async (message) => {
    if (!isCurrent()) {
      cancelComposerRequest(record);
      if (currentComposer(record)) refreshComposer(record);
      return;
    }
    if (message.type === "progress") return;
    cancelComposerRequest(record);
    const restoredSource = record.original;
    record.original = source;
    const replaced = await replaceComposerText(record, message.text.trim());
    if (!currentComposer(record)) return;
    record.status = replaced ? "英語の下書きに変換しました。" : "下書きを更新できませんでした。";
    if (!replaced && composerText(record.editor) === source) record.original = restoredSource;
    refreshComposer(record);
  }, fail);
}

function scanComposers() {
  for (const record of composers.values()) {
    if (!currentComposer(record)) disposeComposer(record);
    else if (!record.applying && composerText(record.editor) !== record.text) composerEdited(record);
  }
  for (const editor of document.querySelectorAll(COMPOSER_SELECTOR)) {
    const form = editor.closest("form");
    if (!form || editor.closest(MESSAGE_CONTAINER_SELECTOR) || editor.closest('[role="dialog"]') ||
        !/^\/channels\/(?:@me|[0-9]+)\/[0-9]+(?:\/[0-9]+)?\/?$/.test(location.pathname)) continue;
    if (composers.has(editor)) continue;
    const ui = document.createElement("div");
    ui.dataset.discordTranslate = "composer";
    ui.className = "discord-translate-composer";
    const translateButton = document.createElement("button");
    const restoreButton = document.createElement("button");
    for (const button of [translateButton, restoreButton]) {
      button.type = "button";
      button.className = "discord-translate-button";
    }
    restoreButton.textContent = "元に戻す";
    const statusElement = document.createElement("span");
    statusElement.setAttribute("role", "status");
    statusElement.setAttribute("aria-live", "polite");
    ui.append(translateButton, restoreButton, statusElement);
    form.appendChild(ui);
    const record = {
      editor, form, path: location.pathname, ui, translateButton, restoreButton, statusElement,
      generation: 0, original: null, pending: false, applying: false, composing: false, status: "", listeners: [],
    };
    const edit = () => composerEdited(record);
    record.listeners = [
      ["beforeinput", edit], ["input", edit],
      ["compositionstart", () => { record.composing = true; composerEdited(record); }],
      ["compositionend", () => { record.composing = false; composerEdited(record); }],
    ];
    for (const [type, listener] of record.listeners) editor.addEventListener(type, listener, true);
    translateButton.addEventListener("click", () => requestDraftTranslation(record));
    restoreButton.addEventListener("click", () => { void restoreComposer(record); });
    composers.set(editor, record);
    refreshComposer(record);
  }
}

function processContainer(container) {
  if (!enabled || !validContainer(container)) return;
  const content = findMessageContent(container);
  if (!content) {
    removeContainerUi(container);
    return;
  }
  const text = normalizedContent(content);
  const previous = records.get(content);

  if (!text) {
    previous?.close?.();
    removeRecordUi(previous);
    removeContainerUi(container);
    records.delete(content);
    return;
  }
  if (previous?.text === text && previous.container === container) return;
  previous?.close?.();
  removeRecordUi(previous);
  removeContainerUi(container);
  const record = {
    container,
    text,
    state: "idle",
    ui: null,
  };
  records.set(content, record);
  showButton(content, container, record);
}

function scan() {
  if (!enabled) return;
  for (const record of activeRequests) {
    if (!currentRecord(record.content, record.container, record)) {
      record.close();
      removeRecordUi(record);
      if (records.get(record.content) === record) records.delete(record.content);
    }
  }
  for (const container of document.querySelectorAll(MESSAGE_CONTAINER_SELECTOR)) processContainer(container);
  scanComposers();
}

function startObserver() {
  if (observer || !document.body) return;
  observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

function applyEnabled(nextEnabled) {
  enabled = nextEnabled === true;
  if (!enabled) {
    for (const record of activeRequests) record.close();
    for (const record of composers.values()) disposeComposer(record);
    stopObserver();
    stopBridge();
    records = new WeakMap();
    removeAllUi();
    return;
  }
  startBridge();
  startObserver();
  scan();
}

async function initialize() {
  try {
    const state = await chrome.storage.local.get({ enabled: false });
    applyEnabled(state?.enabled === true);
  } catch {
    applyEnabled(false);
  }
}

if (typeof window !== "undefined" && typeof chrome !== "undefined" && isDiscordTopFrame()) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && typeof changes.enabled?.newValue === "boolean") {
      applyEnabled(changes.enabled.newValue);
    }
  });
  void initialize();
}
