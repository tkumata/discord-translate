import {
  TranslationError,
  TranslationStream,
  buildPayload,
  normalizeText,
  responseDiagnostics,
  validateResponse,
  validateTargetLanguage,
} from "./translation-protocol.js";

export const FETCH_TIMEOUT_MS = 120_000;
export const QUEUE_WAIT_TIMEOUT_MS = 120_000;
export const MAX_UNIQUE_JOBS = 64;
export const MAX_CACHE_ENTRIES = 256;
export const CACHE_TTL_MS = 30 * 60 * 1000;

function logInvalidResponse(logger, payload) {
  if (typeof logger?.warn !== "function") return;
  try {
    logger.warn("invalid_response", responseDiagnostics(payload));
  } catch {
    // Diagnostics must not change the existing translation result.
  }
}

export async function sha256Hex(text, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw new TranslationError("hash_error");
  const bytes = new TextEncoder().encode(text);
  try {
    const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new TranslationError("hash_error");
  }
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
}

export async function runTranslationRequest(
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
      throw new TranslationError("http_error");
    }
    stream.lastPayload = stream.response();
    return validateResponse(stream.lastPayload);
  } catch (value) {
    if (value instanceof TranslationError && value.code === "invalid_response") {
      logInvalidResponse(logger, /<\/?think>/i.test(stream.text) ? stream.response() : stream.lastPayload);
    }
    if (value instanceof TranslationError) throw value;
    if (timedOut) throw new TranslationError("request_timeout");
    if (value?.name === "NotAllowedError" || value?.name === "SecurityError") {
      throw new TranslationError("lna_denied");
    }
    throw new TranslationError("network_error");
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
    this.pendingHashRequests = [];
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
      this.pendingHashRequests.push({ text: normalized, targetLanguage, tabId, onProgress, signal, resolve, reject });
    });
    this.processHashRequests();
    return promise;
  }

  // Serialize hashing so asynchronous digests cannot reorder incoming requests.
  async processHashRequests() {
    if (this.hashing) return;
    this.hashing = true;
    while (this.pendingHashRequests.length > 0) {
      const request = this.pendingHashRequests.shift();
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
    if (this.jobs.size >= this.maxJobs) throw new TranslationError("queue_full");

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
    this.rejectQueuedJob(job);
    this.removeQueued(job);
    this.pump();
  }

  rejectQueuedJob(job) {
    this.clearTimeoutImpl(job.deadlineTimer);
    job.state = "expired";
    this.jobs.delete(job.key);
    this.clearSubscribers(job);
    job.reject(new TranslationError("queue_timeout"));
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
      if (this.now() - job.enqueuedAt >= this.queueWaitMs) {
        this.rejectQueuedJob(job);
        continue;
      }
      this.clearTimeoutImpl(job.deadlineTimer);
      job.state = "running";
      this.running = true;
      this.run(job);
      return;
    }
  }

  run(job) {
    runTranslationRequest(job.text, {
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
        job.reject(value instanceof TranslationError ? value : new TranslationError("network_error"));
      },
    ).finally(() => {
      this.jobs.delete(job.key);
      this.clearSubscribers(job);
      this.running = false;
      this.pump();
    });
  }
}
