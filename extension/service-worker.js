import { createReceivedTranslationCache } from "./received-translation-cache.js";

export const FETCH_TIMEOUT_MS = 120_000;
export const QUEUE_WAIT_TIMEOUT_MS = 120_000;
export const MAX_UNIQUE_JOBS = 64;
export const MAX_CACHE_ENTRIES = 256;
export const CACHE_TTL_MS = 30 * 60 * 1000;
export const BRIDGE_PORT_NAME = "discord-translate-bridge";
export const REQUEST_PORT_NAME = "discord-translate-request";
export const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;
export const MESSAGE_ID_PATTERN = /^chat-messages-[0-9]+-[0-9]+$/;

export const ERROR_CODES = Object.freeze([
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

const SYSTEM_PROMPT =
  "Translate the user's message into natural Japanese. Output only the translation. " +
  "Preserve Markdown, URLs, usernames, @username, #channel, code blocks, inline code, " +
  "product names, API names, library names, identifiers, and emoji where appropriate. " +
  "Do not explain or repeat the source text.";

const ENGLISH_SYSTEM_PROMPT =
  "Translate the user's message into natural English. Output only the translation. " +
  "Preserve line breaks, Markdown, URLs, usernames, @username, #channel, code blocks, inline code, " +
  "product names, API names, library names, identifiers, and emoji where appropriate. " +
  "Do not explain or repeat the source text.";

export class TranslationError extends Error {
  constructor(code) {
    super(code);
    this.name = "TranslationError";
    this.code = code;
  }
}

function error(code) {
  return new TranslationError(code);
}

export function toErrorCode(value) {
  return value instanceof TranslationError && ERROR_CODES.includes(value.code)
    ? value.code
    : "network_error";
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateSender(sender, runtimeId) {
  if (!isPlainObject(sender) || typeof runtimeId !== "string" || runtimeId.length === 0) {
    return false;
  }
  if (sender.id !== runtimeId || sender.frameId !== 0) return false;
  if (!isPlainObject(sender.tab) || !Number.isInteger(sender.tab.id)) return false;

  try {
    const url = new URL(sender.url);
    return url.protocol === "https:" && url.hostname === "discord.com";
  } catch {
    return false;
  }
}

export function validateBridgePortSender(sender, runtimeId, bridgeUrl) {
  if (!isPlainObject(sender) || typeof runtimeId !== "string" || runtimeId.length === 0) {
    return false;
  }
  if (sender.id !== runtimeId || !Number.isInteger(sender.frameId) || sender.frameId <= 0) {
    return false;
  }
  if (!isPlainObject(sender.tab) || !Number.isInteger(sender.tab.id)) return false;
  if (typeof sender.url !== "string" || sender.url !== bridgeUrl) return false;

  try {
    return new URL(sender.url).origin === new URL(bridgeUrl).origin;
  } catch {
    return false;
  }
}

function createJobId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeText(text) {
  if (typeof text !== "string") throw error("invalid_input");
  const normalized = text.trim();
  if (normalized.length < 1 || normalized.length > 8000) throw error("invalid_input");
  return normalized;
}

export function validateMessage(message) {
  if (!isPlainObject(message)) throw error("invalid_input");
  const keys = Object.keys(message).sort();
  if (message.type === "translateDraft" && keys.join(",") === "text,type") {
    return { text: normalizeText(message.text), targetLanguage: "en" };
  }
  if (keys.length !== 3 || keys.join(",") !== "messageId,text,type") {
    throw error("invalid_input");
  }
  if (message.type !== "translate" || typeof message.messageId !== "string") {
    throw error("invalid_input");
  }
  if (!MESSAGE_ID_PATTERN.test(message.messageId)) throw error("invalid_input");
  return { messageId: message.messageId, text: normalizeText(message.text), targetLanguage: "ja" };
}

function validateTargetLanguage(targetLanguage) {
  if (targetLanguage !== "ja" && targetLanguage !== "en") throw error("invalid_input");
}

export function buildPayload(text, targetLanguage = "ja") {
  validateTargetLanguage(targetLanguage);
  const normalized = normalizeText(text);
  return {
    messages: [
      { role: "system", content: targetLanguage === "en" ? ENGLISH_SYSTEM_PROMPT : SYSTEM_PROMPT },
      { role: "user", content: normalized },
    ],
    chat_template_kwargs: { enable_thinking: false },
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    max_tokens: 1024,
    stream: true,
    stream_options: { include_usage: true },
  };
}

function hasReasoningField(value) {
  return ["reasoning", "reasoning_content"].some((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );
}

export function responseDiagnostics(payload) {
  const choice = isPlainObject(payload) && Array.isArray(payload.choices)
    ? payload.choices[0]
    : null;
  const message = isPlainObject(choice)
    ? (isPlainObject(choice.message) ? choice.message : isPlainObject(choice.delta) ? choice.delta : null)
    : null;
  const content = message && typeof message.content === "string" ? message.content : null;
  return {
    finish_reason: isPlainObject(choice) && typeof choice.finish_reason === "string"
      ? choice.finish_reason
      : null,
    content_present: content !== null,
    reasoning_present: [payload, choice, message].some(
      (value) => isPlainObject(value) && hasReasoningField(value),
    ) || (content !== null && /<\/?think>/i.test(content)),
    usage_total_tokens_present: isPlainObject(payload?.usage) &&
      Number.isInteger(payload.usage.total_tokens) &&
      payload.usage.total_tokens >= 0,
  };
}

function logInvalidResponse(logger, payload) {
  if (typeof logger?.warn !== "function") return;
  try {
    logger.warn("invalid_response", responseDiagnostics(payload));
  } catch {
    // Diagnostics must not change the existing translation result.
  }
}

export function validateResponse(payload) {
  if (!isPlainObject(payload) || hasReasoningField(payload)) throw error("invalid_response");
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw error("invalid_response");
  }

  const choice = payload.choices[0];
  if (!isPlainObject(choice) || hasReasoningField(choice) || choice.finish_reason !== "stop") {
    throw error("invalid_response");
  }
  if (!isPlainObject(choice.message) || hasReasoningField(choice.message)) {
    throw error("invalid_response");
  }
  if (typeof choice.message.content !== "string") throw error("invalid_response");

  const translation = choice.message.content.trim();
  if (translation.length === 0 || /<\/?think>/i.test(translation)) {
    throw error("invalid_response");
  }
  if (
    !isPlainObject(payload.usage) ||
    !Number.isInteger(payload.usage.total_tokens) ||
    payload.usage.total_tokens < 0
  ) {
    throw error("invalid_response");
  }
  return translation;
}

export class TranslationStream {
  constructor(onProgress = () => {}) {
    this.onProgress = onProgress;
    this.text = "";
    this.finishReason = null;
    this.usage = null;
    this.lastPayload = null;
  }

  push(payload) {
    this.lastPayload = payload;
    if (!isPlainObject(payload) || hasReasoningField(payload) || !Array.isArray(payload.choices)) {
      throw error("invalid_response");
    }
    if (payload.choices.length === 0) {
      if (this.finishReason !== "stop" || this.usage !== null ||
          !isPlainObject(payload.usage) || !Number.isInteger(payload.usage.total_tokens) ||
          payload.usage.total_tokens < 0) throw error("invalid_response");
      this.usage = payload.usage;
      return;
    }
    if (payload.choices.length !== 1 || this.finishReason !== null || payload.usage != null) {
      throw error("invalid_response");
    }
    const choice = payload.choices[0];
    const delta = choice?.delta;
    if (!isPlainObject(choice) || hasReasoningField(choice) ||
        (choice.index !== undefined && choice.index !== 0) ||
        !isPlainObject(delta) || hasReasoningField(delta) ||
        Object.hasOwn(delta, "tool_calls") || Object.hasOwn(delta, "function_call") ||
        (delta.role !== undefined && delta.role !== "assistant") ||
        (delta.content !== undefined && typeof delta.content !== "string")) {
      throw error("invalid_response");
    }
    if (choice.finish_reason != null) {
      this.finishReason = choice.finish_reason;
      if (this.finishReason !== "stop") throw error("invalid_response");
    }
    if (delta.content) {
      this.text += delta.content;
      if (this.text.length > 64 * 1024 || /<\/?think>/i.test(this.text)) throw error("invalid_response");
      // Hold a possible split thinking marker (and split UTF-16 surrogate) until it is identifiable.
      const pending = this.text.match(/<\/?(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$|[\uD800-\uDBFF]$/i);
      const visible = pending ? this.text.slice(0, pending.index) : this.text;
      if (visible) this.onProgress(visible);
    }
  }

  response() {
    return {
      choices: [{ finish_reason: this.finishReason, message: { content: this.text } }],
      usage: this.usage,
    };
  }
}

export async function sha256Hex(text, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw error("hash_error");
  const bytes = new TextEncoder().encode(text);
  try {
    const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw error("hash_error");
  }
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
}

export async function fetchTranslation(
  text,
  {
    requestImpl,
    logger = globalThis.console,
    timeoutMs = FETCH_TIMEOUT_MS,
    setTimeoutImpl = (...args) => globalThis.setTimeout(...args),
    clearTimeoutImpl = (...args) => globalThis.clearTimeout(...args),
    onProgress,
    targetLanguage = "ja",
  } = {},
) {
  const controller = new AbortController();
  const stream = new TranslationStream(onProgress);
  let timedOut = false;
  const timeout = setTimeoutImpl(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  unrefTimer(timeout);

  try {
    const payload = buildPayload(text, targetLanguage);
    const response = await requestImpl(payload, {
      signal: controller.signal,
      onChunk: (chunk) => stream.push(chunk),
    });
    if (!response || response.status !== 200) {
      throw error("http_error");
    }
    stream.lastPayload = stream.response();
    return validateResponse(stream.lastPayload);
  } catch (value) {
    if (value instanceof TranslationError && value.code === "invalid_response") {
      logInvalidResponse(logger, /<\/?think>/i.test(stream.text) ? stream.response() : stream.lastPayload);
    }
    if (value instanceof TranslationError) throw value;
    if (timedOut) throw error("request_timeout");
    if (value?.name === "NotAllowedError" || value?.name === "SecurityError") {
      throw error("lna_denied");
    }
    throw error("network_error");
  } finally {
    controller.abort();
    clearTimeoutImpl(timeout);
  }
}

export class TranslationQueue {
  constructor({
    requestImpl,
    logger = globalThis.console,
    hashImpl = sha256Hex,
    now = () => Date.now(),
    setTimeoutImpl = (...args) => globalThis.setTimeout(...args),
    clearTimeoutImpl = (...args) => globalThis.clearTimeout(...args),
    maxJobs = MAX_UNIQUE_JOBS,
    queueWaitMs = QUEUE_WAIT_TIMEOUT_MS,
    fetchTimeoutMs = FETCH_TIMEOUT_MS,
    cacheLimit = MAX_CACHE_ENTRIES,
    cacheTtlMs = CACHE_TTL_MS,
  } = {}) {
    this.requestImpl = requestImpl;
    this.logger = logger;
    this.hashImpl = hashImpl;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.maxJobs = maxJobs;
    this.queueWaitMs = queueWaitMs;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.cacheLimit = cacheLimit;
    this.cacheTtlMs = cacheTtlMs;
    this.queue = [];
    this.jobs = new Map();
    this.cache = new Map();
    this.hashQueue = [];
    this.hashing = false;
    this.running = false;
  }

  translate(text, tabId = null, { onProgress, signal, targetLanguage = "ja" } = {}) {
    let normalized;
    try {
      normalized = normalizeText(text);
      validateTargetLanguage(targetLanguage);
    } catch (value) {
      return Promise.reject(value);
    }

    const promise = new Promise((resolve, reject) => {
      this.hashQueue.push({ text: normalized, targetLanguage, tabId, onProgress, signal, resolve, reject });
    });
    this.processHashQueue();
    return promise;
  }

  async processHashQueue() {
    if (this.hashing) return;
    this.hashing = true;
    while (this.hashQueue.length > 0) {
      const request = this.hashQueue.shift();
      try {
        const key = await this.hashImpl(JSON.stringify([request.targetLanguage, request.text]));
        Promise.resolve(this.enqueue(key, request.text, request.tabId, request)).then(request.resolve, request.reject);
      } catch (value) {
        request.reject(value);
      }
    }
    this.hashing = false;
  }

  enqueue(key, text, tabId, options) {
    const cached = this.getCached(key);
    if (cached !== undefined) return cached;

    const existing = this.jobs.get(key);
    if (existing) {
      this.subscribe(existing, options);
      return existing.promise;
    }
    if (this.jobs.size >= this.maxJobs) throw error("queue_full");

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const job = {
      key,
      text,
      targetLanguage: options.targetLanguage,
      tabId,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      state: "queued",
      enqueuedAt: this.now(),
      deadlineTimer: null,
      subscribers: new Set(),
      progress: "",
    };
    this.jobs.set(key, job);
    this.subscribe(job, options);
    this.queue.push(job);
    job.deadlineTimer = this.setTimeoutImpl(() => this.expire(job), this.queueWaitMs);
    unrefTimer(job.deadlineTimer);
    this.pump();
    return promise;
  }

  subscribe(job, { onProgress, signal } = {}) {
    if (typeof onProgress !== "function" || signal?.aborted) return;
    const subscriber = { onProgress, signal, abort: null };
    subscriber.abort = () => {
      job.subscribers.delete(subscriber);
      signal?.removeEventListener("abort", subscriber.abort);
    };
    job.subscribers.add(subscriber);
    signal?.addEventListener("abort", subscriber.abort, { once: true });
    if (job.progress) onProgress(job.progress);
  }

  clearSubscribers(job) {
    for (const subscriber of job.subscribers) subscriber.abort();
  }

  getCached(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.text;
  }

  saveCache(key, text) {
    this.cache.delete(key);
    this.cache.set(key, { text, expiresAt: this.now() + this.cacheTtlMs });
    while (this.cache.size > this.cacheLimit && this.cache.size > 0) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  expire(job) {
    if (job.state !== "queued") return;
    job.state = "expired";
    this.jobs.delete(job.key);
    this.clearSubscribers(job);
    this.removeQueued(job);
    job.reject(error("queue_timeout"));
    this.pump();
  }

  removeQueued(job) {
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
  }

  pump() {
    if (this.running) return;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (job.state !== "queued") continue;
      this.clearTimeoutImpl(job.deadlineTimer);
      if (this.now() - job.enqueuedAt >= this.queueWaitMs) {
        job.state = "expired";
        this.jobs.delete(job.key);
        this.clearSubscribers(job);
        job.reject(error("queue_timeout"));
        continue;
      }
      job.state = "running";
      this.running = true;
      this.run(job);
      return;
    }
  }

  run(job) {
    fetchTranslation(job.text, {
      targetLanguage: job.targetLanguage,
      requestImpl: (payload, options) => this.requestImpl(job.tabId, payload, options),
      logger: this.logger,
      timeoutMs: this.fetchTimeoutMs,
      setTimeoutImpl: this.setTimeoutImpl,
      clearTimeoutImpl: this.clearTimeoutImpl,
      onProgress: (text) => {
        // ponytail: cumulative text is bounded by 1024 tokens; use deltas if transfer cost matters.
        job.progress = text;
        for (const subscriber of job.subscribers) subscriber.onProgress(text);
      },
    }).then(
      (translation) => {
        this.saveCache(job.key, translation);
        job.resolve(translation);
      },
      (value) => {
        job.reject(value instanceof TranslationError ? value : error("network_error"));
      },
    ).finally(() => {
      this.jobs.delete(job.key);
      this.clearSubscribers(job);
      this.running = false;
      this.pump();
    });
  }
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
    if (!Number.isInteger(tabId)) return Promise.reject(error("bridge_unavailable"));
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
      item.abort = () => this.finish(item, error("request_timeout"));
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
        () => this.finish(item, error("bridge_unavailable")),
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
      this.finish(item, error("bridge_unavailable"));
    }
  }

  receive(entry, message) {
    const jobId = message?.jobId;
    const item = this.pending.get(jobId);
    if (!item || item.entry !== entry) return;
    const result = bridgeResult(message, jobId);
    if (!result) {
      this.finish(item, error("invalid_response"));
    } else if (result.error) {
      this.finish(item, error(result.error));
    } else if (Object.hasOwn(result, "chunk")) {
      try {
        item.onChunk?.(result.chunk);
      } catch (value) {
        this.finish(item, value instanceof TranslationError ? value : error("network_error"));
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
      if (item.entry === entry) this.finish(item, error("bridge_unavailable"));
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
      if (!isPlainObject(message)) throw error("invalid_input");
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
