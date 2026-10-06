import {
  TranslationError,
  isPlainObject,
  validateBridgePortSender,
} from "./translation-protocol.js";

export const BRIDGE_PORT_NAME = "discord-translate-bridge";
export const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;

function createJobId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
}

const BRIDGE_RESULT_ERRORS = new Set([
  "lna_denied",
  "request_timeout",
  "network_error",
  "invalid_response",
]);

function bridgeResult(message, jobId) {
  if (
    !isPlainObject(message) ||
    message.jobId !== jobId
  ) {
    return null;
  }
  const keys = Object.keys(message).sort();
  if (message.type === "chunk" && keys.join(",") === "jobId,payload,type") {
    return { chunk: message.payload };
  }
  if (message.type === "end" && keys.join(",") === "jobId,type") return { end: true };
  if (message.type === "result" && keys.join(",") === "jobId,status,type") {
    return message.status !== 200 &&
      Number.isInteger(message.status) &&
      message.status >= 100 &&
      message.status <= 599
      ? { status: message.status }
      : null;
  }
  if (message.type === "error" && keys.join(",") === "error,jobId,type") {
    return BRIDGE_RESULT_ERRORS.has(message.error) ? { error: message.error } : null;
  }
  return null;
}

export class BridgeRegistry {
  constructor({
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  } = {}) {
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.bridges = new Map();
    this.pending = new Map();
  }

  request(tabId, payload, { signal, onChunk } = {}) {
    if (!Number.isInteger(tabId)) return Promise.reject(new TranslationError("bridge_unavailable"));
    const jobId = createJobId();
    return new Promise((resolve, reject) => {
      const item = {
        jobId,
        tabId,
        payload,
        signal,
        onChunk,
        entry: null,
        timer: null,
        abort: null,
        resolve,
        reject,
      };
      this.pending.set(jobId, item);
      item.abort = () => this.finish(item, new TranslationError("request_timeout"));
      signal?.addEventListener?.("abort", item.abort, { once: true });
      if (signal?.aborted) {
        item.abort();
        return;
      }

      const bridge = this.bridges.get(tabId);
      if (bridge) {
        this.send(item, bridge);
        return;
      }
      item.timer = this.setTimeoutImpl(
        () => this.finish(item, new TranslationError("bridge_unavailable")),
        BRIDGE_CONNECT_TIMEOUT_MS,
      );
      unrefTimer(item.timer);
    });
  }

  connect(port, runtimeId, bridgeUrl) {
    if (
      port?.name !== BRIDGE_PORT_NAME ||
      !validateBridgePortSender(port.sender, runtimeId, bridgeUrl) ||
      !port.onMessage?.addListener ||
      !port.onDisconnect?.addListener
    ) {
      port?.disconnect?.();
      return false;
    }

    const tabId = port.sender.tab.id;
    const previous = this.bridges.get(tabId);
    if (previous) previous.port.disconnect?.();
    const entry = { port, tabId };
    this.bridges.set(tabId, entry);
    port.onMessage.addListener((message) => this.receive(entry, message));
    port.onDisconnect.addListener(() => this.disconnect(entry));

    for (const item of this.pending.values()) {
      if (item.tabId === tabId && item.entry === null) this.send(item, entry);
    }
    return true;
  }

  send(item, entry) {
    if (item.entry !== null || this.bridges.get(item.tabId) !== entry) return;
    item.entry = entry;
    if (item.timer) {
      this.clearTimeoutImpl(item.timer);
      item.timer = null;
    }
    try {
      entry.port.postMessage({ type: "translate", jobId: item.jobId, payload: item.payload });
    } catch {
      this.finish(item, new TranslationError("bridge_unavailable"));
    }
  }

  receive(entry, message) {
    const jobId = message?.jobId;
    const item = this.pending.get(jobId);
    if (!item || item.entry !== entry) return;
    const result = bridgeResult(message, jobId);
    if (!result) {
      this.finish(item, new TranslationError("invalid_response"));
    } else if (result.error) {
      this.finish(item, new TranslationError(result.error));
    } else if (Object.hasOwn(result, "chunk")) {
      try {
        item.onChunk?.(result.chunk);
      } catch (value) {
        this.finish(item, value instanceof TranslationError ? value : new TranslationError("network_error"));
      }
    } else if (result.end) {
      this.finish(item, null, { status: 200 });
    } else {
      this.finish(item, null, result);
    }
  }

  disconnect(entry) {
    if (this.bridges.get(entry.tabId) === entry) this.bridges.delete(entry.tabId);
    for (const item of this.pending.values()) {
      if (item.entry === entry) this.finish(item, new TranslationError("bridge_unavailable"));
    }
  }

  finish(item, failure, value) {
    if (!this.pending.delete(item.jobId)) return;
    if (item.timer) this.clearTimeoutImpl(item.timer);
    item.signal?.removeEventListener?.("abort", item.abort);
    if (failure && item.entry) {
      try {
        item.entry.port.postMessage({ type: "abort", jobId: item.jobId });
      } catch {
        // A disconnected transport cannot receive cleanup; preserve the original failure.
      }
    }
    if (failure) item.reject(failure);
    else item.resolve(value);
  }
}
