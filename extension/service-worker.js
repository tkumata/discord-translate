import { createReceivedTranslationCache } from "./received-translation-cache.js";
import {
  isPlainObject,
  TranslationError,
  toErrorCode,
  validateMessage,
  validateSender,
} from "./translation-protocol.js";
import { TranslationQueue, sha256Hex } from "./translation-queue.js";
import { BridgeRegistry } from "./bridge-registry.js";

export const REQUEST_PORT_NAME = "discord-translate-request";

export function connectRequestPort(port, runtimeId, translator, receivedCache) {
  if (port?.name !== REQUEST_PORT_NAME || !validateSender(port.sender, runtimeId)) {
    port?.disconnect?.();
    return false;
  }
  let received = false;
  let closed = false;
  const controller = new AbortController();
  const send = (message) => {
    if (closed) return;
    try {
      port.postMessage(message);
    } catch {
      closed = true;
      controller.abort();
    }
  };
  const finish = (message) => {
    send(message);
    closed = true;
    controller.abort();
  };
  port.onDisconnect.addListener(() => {
    closed = true;
    controller.abort();
  });
  port.onMessage.addListener((message) => {
    if (closed) return;
    if (received) {
      finish({ type: "error", error: "invalid_input" });
      return;
    }
    received = true;
    let validated;
    try {
      validated = validateMessage(message);
    } catch (value) {
      finish({ type: "error", error: toErrorCode(value) });
      return;
    }
    translator.translate(validated.text, port.sender.tab.id, {
      targetLanguage: validated.targetLanguage,
      signal: controller.signal,
      onProgress: (text) => send({ type: "progress", text }),
    }).then(
      async (text) => {
        if (closed) return;
        if (validated.targetLanguage === "en") {
          finish({ type: "result", text });
          return;
        }
        const cache = await receivedCache.save(validated, text, { signal: controller.signal });
        finish({ type: "result", text, cache });
      },
      (value) => finish({ type: "error", error: toErrorCode(value) }),
    );
  });
  return true;
}

export const defaultBridgeRegistry = new BridgeRegistry();
export const defaultTranslator = new TranslationQueue({
  requestImpl: (tabId, payload, options) => defaultBridgeRegistry.request(tabId, payload, options),
});

export function registerChromeListeners(
  chromeApi = globalThis.chrome,
  translator = defaultTranslator,
  bridgeRegistry = defaultBridgeRegistry,
  receivedCache = createReceivedTranslationCache(chromeApi?.storage?.local, { hashImpl: sha256Hex }),
) {
  if (!chromeApi?.runtime?.onConnect?.addListener) return false;

  chromeApi.runtime.onConnect.addListener((port) => {
    if (port.name === REQUEST_PORT_NAME) {
      connectRequestPort(port, chromeApi.runtime.id, translator, receivedCache);
      return;
    }
    bridgeRegistry.connect(
      port,
      chromeApi.runtime.id,
      chromeApi.runtime.getURL("bridge.html"),
    );
  });

  chromeApi.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "lookupTranslation") return false;
    if (!validateSender(sender, chromeApi.runtime.id)) {
      respond({ status: "miss", error: "invalid_sender" });
      return false;
    }
    let validated;
    try {
      if (!isPlainObject(message)) throw new TranslationError("invalid_input");
      validated = validateMessage({ ...message, type: "translate" });
    }
    catch {
      respond({ status: "miss", error: "invalid_input" });
      return false;
    }
    void receivedCache.lookup(validated).then(respond);
    return true;
  });
  void receivedCache.cleanup();

  if (chromeApi.runtime.onInstalled?.addListener) {
    chromeApi.runtime.onInstalled.addListener((details) => {
      if (details?.reason === "install") {
        void chromeApi.storage?.local?.set?.({ enabled: false });
      }
    });
  }
  return true;
}

if (typeof chrome !== "undefined") registerChromeListeners();
