const BRIDGE_SELECTOR = 'iframe[data-discord-translate-bridge="true"]';
let enabled = false;
let observer = null;
let bridge = null;
let receivedMessages = null;
let draftComposer = null;

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

function scan() {
  if (!enabled) return;
  receivedMessages.scan();
  draftComposer.scan();
}

function startObserver() {
  if (observer || !document.body) return;
  observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["id"] });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

function applyEnabled(nextEnabled) {
  enabled = nextEnabled === true;
  if (!enabled) {
    receivedMessages?.dispose();
    draftComposer?.dispose();
    receivedMessages = null;
    draftComposer = null;
    stopObserver();
    stopBridge();
    for (const element of document.querySelectorAll("[data-discord-translate]")) element.remove();
    return;
  }
  receivedMessages ??= createReceivedMessages(openTranslationRequest);
  draftComposer ??= createDraftComposer(openTranslationRequest);
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
    if (areaName === "local" && changes.provider) {
      applyEnabled(false);
    }
    if (areaName === "local" && typeof changes.enabled?.newValue === "boolean") {
      applyEnabled(changes.enabled.newValue);
    }
  });
  void initialize();
}
