const MAX_TRANSLATION_INPUT_LENGTH = 8000;

const openTranslationRequest = (() => {
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

  function responseKeys(value) {
    return value && typeof value === "object" ? Object.keys(value).sort().join(",") : "";
  }

  function validSavedTranslationResult(message, requestType) {
    if (requestType !== "translate" || message.type !== "result" || responseKeys(message) !== "cache,text,type") return false;
    const cache = message.cache;
    if (responseKeys(cache) !== "error,saved" || typeof cache.saved !== "boolean") return false;
    return cache.saved
      ? cache.error === null || cache.error === "cache_cleanup_failed"
      : cache.error === "cache_write_failed";
  }

  function validTranslationEvent(message, requestType) {
    if (message?.type !== "progress" && message?.type !== "result") return false;
    if (responseKeys(message) !== "text,type" && !validSavedTranslationResult(message, requestType)) return false;
    return typeof message.text === "string" && message.text.length > 0 && message.text.length <= 64 * 1024 &&
      (message.type === "progress" || message.text.trim().length > 0);
  }

  function fixedErrorCode(response) {
    return TRANSLATION_ERROR_CODES.has(response?.error) ? response.error : "network_error";
  }

  function openRequest(payload, receive, fail) {
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
        if (validTranslationEvent(message, payload.type)) {
          if (message.type === "result") close();
          receive(message);
        } else if (message?.type === "error" && responseKeys(message) === "error,type") {
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

  return openRequest;
})();
