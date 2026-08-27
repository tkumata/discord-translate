const MESSAGE_CONTAINER_SELECTOR = 'li[id^="chat-messages-"]';
const MESSAGE_CONTENT_SELECTOR = '[id^="message-content-"]';
const MESSAGE_ID_PATTERN = /^chat-messages-[0-9]+-[0-9]+$/;
const CONTENT_ID_PATTERN = /^message-content-[0-9]+$/;
const MAX_TEXT_LENGTH = 8000;
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

function showTranslation(content, record, translation) {
  removeRecordUi(record);
  const element = document.createElement("div");
  element.dataset.discordTranslate = "translation";
  element.className = "discord-translate-translation";
  element.lang = "ja";
  const label = document.createElement("span");
  label.className = "discord-translate-translation-label";
  label.textContent = "日本語訳";
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

async function requestTranslation(content, container, retry = false) {
  if (!enabled || !container.isConnected || !content.isConnected) return;
  const text = normalizedContent(content);
  if (!text) return;

  const previous = records.get(content);
  if (!previous || previous.text !== text || previous.container !== container) return;
  if (!retry && previous.state !== "idle") return;
  if (retry && previous.state !== "failed") return;

  const record = {
    container,
    text,
    state: "pending",
    ui: null,
  };
  records.set(content, record);
  showLoading(content, record);

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "translate",
      messageId: container.id,
      text,
    });
  } catch {
    response = { ok: false };
  }

  if (!currentRecord(content, container, record)) return;
  if (response?.ok === true && typeof response.text === "string" && response.text.trim() !== "") {
    record.state = "succeeded";
    showTranslation(content, record, response.text.trim());
    return;
  }
  record.state = "failed";
  showFailure(content, container, record, fixedErrorCode(response));
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
    removeRecordUi(previous);
    removeContainerUi(container);
    records.delete(content);
    return;
  }
  if (previous?.text === text && previous.container === container) return;
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

function scan(root = document) {
  if (!enabled) return;
  const containers = [];
  if (root instanceof Element && root.matches(MESSAGE_CONTAINER_SELECTOR)) containers.push(root);
  if (typeof root.querySelectorAll === "function") {
    containers.push(...root.querySelectorAll(MESSAGE_CONTAINER_SELECTOR));
  }
  for (const container of containers) processContainer(container);
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
