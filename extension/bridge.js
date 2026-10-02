export const API_URL = "http://127.0.0.1:8080/v1/chat/completions";
export const BRIDGE_PORT_NAME = "discord-translate-bridge";
export const FETCH_TIMEOUT_MS = 120_000;

const PAYLOAD_KEYS = [
  "chat_template_kwargs",
  "max_tokens",
  "messages",
  "min_p",
  "stream",
  "stream_options",
  "temperature",
  "top_k",
  "top_p",
];
const MESSAGE_KEYS = ["content", "role"];
const ERROR_CODES = new Set(["invalid_response", "lna_denied", "network_error", "request_timeout"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return isPlainObject(value) && Object.keys(value).sort().join(",") === expected.slice().sort().join(",");
}

function logInvalidResponse(logger) {
  if (typeof logger?.warn !== "function") return;
  try {
    logger.warn("invalid_response", {
      finish_reason: null,
      content_present: false,
      reasoning_present: false,
      usage_total_tokens_present: false,
    });
  } catch {
    // Diagnostics must not change the existing bridge result.
  }
}

export function validateBridgeRequest(message) {
  if (!exactKeys(message, ["jobId", "payload", "type"])) return false;
  if (message.type !== "translate" || typeof message.jobId !== "string" || message.jobId.length === 0) {
    return false;
  }
  const payload = message.payload;
  if (!exactKeys(payload, PAYLOAD_KEYS)) return false;
  if (!Array.isArray(payload.messages) || payload.messages.length !== 2) return false;
  if (
    !exactKeys(payload.messages[0], MESSAGE_KEYS) ||
    payload.messages[0].role !== "system" ||
    typeof payload.messages[0].content !== "string" ||
    payload.messages[0].content.length === 0
  ) {
    return false;
  }
  if (
    !exactKeys(payload.messages[1], MESSAGE_KEYS) ||
    payload.messages[1].role !== "user" ||
    typeof payload.messages[1].content !== "string" ||
    payload.messages[1].content.length < 1 ||
    payload.messages[1].content.length > 8000
  ) {
    return false;
  }
  return (
    exactKeys(payload.chat_template_kwargs, ["enable_thinking"]) &&
    payload.chat_template_kwargs.enable_thinking === false &&
    payload.temperature === 0.7 &&
    payload.top_p === 0.8 &&
    payload.top_k === 20 &&
    payload.min_p === 0 &&
    payload.max_tokens === 1024 &&
    payload.stream === true &&
    exactKeys(payload.stream_options, ["include_usage"]) &&
    payload.stream_options.include_usage === true
  );
}

export async function readSse(body, onEvent, signal) {
  if (!body?.getReader) throw new SyntaxError();
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data = [];
  let eventBytes = 0;
  const encoder = new TextEncoder();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("", "AbortError");
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException("", "AbortError");
      try {
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      } catch {
        throw new SyntaxError();
      }
      while (true) {
        if (signal?.aborted) throw new DOMException("", "AbortError");
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (!done && buffer[end] === "\r" && end === buffer.length - 1)) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1));
        if (line === "") {
          if (data.length > 0) {
            const event = data.join("\n");
            data = [];
            eventBytes = 0;
            if (event === "[DONE]") return;
            onEvent(JSON.parse(event));
          }
        } else if (line === "data" || line.startsWith("data:")) {
          const text = line.slice(5).replace(/^ /, "");
          data.push(text);
          eventBytes += encoder.encode(text).length + 1;
          if (eventBytes > 1024 * 1024) throw new SyntaxError();
        }
      }
      if (encoder.encode(buffer).length + eventBytes > 1024 * 1024) throw new SyntaxError();
      if (done) throw new SyntaxError(); // An EOF without [DONE] is not a completed translation.
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    // Cancellation errors after completion must not replace the translation result.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function classifyBridgeError(value, timedOut = false) {
  if (timedOut) return "request_timeout";
  if (value?.name === "NotAllowedError" || value?.name === "SecurityError") return "lna_denied";
  return "network_error";
}

function sendError(port, jobId, error) {
  if (!ERROR_CODES.has(error)) error = "network_error";
  try {
    port.postMessage({ type: "error", jobId, error });
  } catch {
    // The service worker disconnected while the request was finishing.
  }
}

export async function handleBridgeRequest(
  port,
  message,
  pendingJobs,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    logger = globalThis.console,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  } = {},
) {
  if (exactKeys(message, ["jobId", "type"]) && message.type === "abort") {
    pendingJobs.get(message.jobId)?.abort();
    return;
  }
  if (message?.type === "abort") return;
  if (!validateBridgeRequest(message) || pendingJobs.has(message?.jobId)) {
    if (typeof message?.jobId === "string") sendError(port, message.jobId, "invalid_response");
    return;
  }
  const controller = new AbortController();
  pendingJobs.set(message.jobId, controller);
  let timedOut = false;
  const timeout = setTimeoutImpl(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload),
      signal: controller.signal,
    });
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      sendError(port, message.jobId, "invalid_response");
    } else if (response.status !== 200) {
      port.postMessage({ type: "result", jobId: message.jobId, status: response.status });
    } else {
      try {
        if (response.headers?.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream") {
          throw new SyntaxError();
        }
        await readSse(response.body, (payload) => {
          port.postMessage({ type: "chunk", jobId: message.jobId, payload });
        }, controller.signal);
      } catch (value) {
        if (controller.signal.aborted) {
          if (timedOut) sendError(port, message.jobId, "request_timeout");
          return;
        }
        if (!(value instanceof SyntaxError)) throw value;
        logInvalidResponse(logger);
        sendError(port, message.jobId, "invalid_response");
        return;
      }
      port.postMessage({ type: "end", jobId: message.jobId });
    }
  } catch (value) {
    if (!controller.signal.aborted || timedOut) {
      sendError(port, message.jobId, classifyBridgeError(value, timedOut));
    }
  } finally {
    controller.abort();
    clearTimeoutImpl(timeout);
    pendingJobs.delete(message.jobId);
  }
}

export function connectBridge(chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.connect) return false;
  const port = chromeApi.runtime.connect({ name: BRIDGE_PORT_NAME });
  const pendingJobs = new Map();
  port.onMessage.addListener((message) => {
    void handleBridgeRequest(port, message, pendingJobs);
  });
  port.onDisconnect.addListener(() => {
    for (const controller of pendingJobs.values()) controller.abort();
    connectBridge(chromeApi);
  });
  return true;
}

if (typeof chrome !== "undefined") connectBridge();
