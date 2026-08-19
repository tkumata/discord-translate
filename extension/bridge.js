export const API_URL = "http://127.0.0.1:8080/v1/chat/completions";
export const BRIDGE_PORT_NAME = "discord-translate-bridge";
export const FETCH_TIMEOUT_MS = 120_000;

const PAYLOAD_KEYS = [
  "chat_template_kwargs",
  "max_tokens",
  "messages",
  "min_p",
  "stream",
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

export function responseDiagnostics(payload) {
  const choice = isPlainObject(payload) && Array.isArray(payload.choices)
    ? payload.choices[0]
    : null;
  const message = isPlainObject(choice) && isPlainObject(choice.message) ? choice.message : null;
  const content = message && typeof message.content === "string" ? message.content : null;
  return {
    finish_reason: isPlainObject(choice) && typeof choice.finish_reason === "string"
      ? choice.finish_reason
      : null,
    content_present: content !== null,
    reasoning_present: [payload, choice, message].some(
      (value) => isPlainObject(value) && ["reasoning", "reasoning_content"].some((field) =>
        Object.prototype.hasOwnProperty.call(value, field),
      ),
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
    payload.stream === false
  );
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
  if (!validateBridgeRequest(message) || pendingJobs.has(message?.jobId)) {
    if (typeof message?.jobId === "string") sendError(port, message.jobId, "invalid_response");
    return;
  }
  pendingJobs.add(message.jobId);
  const controller = new AbortController();
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
      let payload;
      try {
        payload = await response.json();
      } catch {
        logInvalidResponse(logger, null);
        sendError(port, message.jobId, "invalid_response");
        return;
      }
      port.postMessage({ type: "result", jobId: message.jobId, status: 200, payload });
    }
  } catch (value) {
    sendError(port, message.jobId, classifyBridgeError(value, timedOut));
  } finally {
    clearTimeoutImpl(timeout);
    pendingJobs.delete(message.jobId);
  }
}

function connectBridge(chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.connect) return false;
  const port = chromeApi.runtime.connect({ name: BRIDGE_PORT_NAME });
  const pendingJobs = new Set();
  port.onMessage.addListener((message) => {
    void handleBridgeRequest(port, message, pendingJobs);
  });
  port.onDisconnect.addListener(() => {
    connectBridge(chromeApi);
  });
  return true;
}

if (typeof chrome !== "undefined") connectBridge();
