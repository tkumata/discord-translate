export const HEALTH_URL = "http://127.0.0.1:8080/health";
export const HEALTH_TIMEOUT_MS = 5_000;
export const HEALTH_ERROR_CODES = Object.freeze([
  "lna_denied",
  "health_timeout",
  "health_network_error",
  "health_http_error",
  "health_invalid_response",
]);

function isStrictHealthyPayload(payload) {
  if (payload === null || typeof payload !== "object") return false;
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(payload);
  return keys.length === 1 && keys[0] === "status" && payload.status === "ok";
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
}

export async function checkHealth({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = HEALTH_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeoutImpl(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  unrefTimer(timeout);

  try {
    const response = await fetchImpl(HEALTH_URL, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response || response.status !== 200 || typeof response.json !== "function") {
      return { ok: false, error: "health_http_error" };
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: "health_invalid_response" };
    }
    return isStrictHealthyPayload(payload)
      ? { ok: true }
      : { ok: false, error: "health_invalid_response" };
  } catch (value) {
    if (timedOut) return { ok: false, error: "health_timeout" };
    if (value?.name === "NotAllowedError") return { ok: false, error: "lna_denied" };
    return { ok: false, error: "health_network_error" };
  } finally {
    clearTimeoutImpl(timeout);
  }
}

function normalizeHealthResult(result) {
  if (result?.ok === true) return { enabled: true, error: null };
  const error = HEALTH_ERROR_CODES.includes(result?.error)
    ? result.error
    : "health_network_error";
  return { enabled: false, error };
}

export async function enableTranslation({ healthCheck = checkHealth, setEnabled }) {
  let result;
  try {
    result = await healthCheck();
  } catch {
    result = { ok: false, error: "health_network_error" };
  }
  const state = normalizeHealthResult(result);
  await setEnabled(state.enabled);
  return state;
}

export async function disableTranslation({ setEnabled }) {
  await setEnabled(false);
  return { enabled: false };
}

const STATUS_MESSAGES = Object.freeze({
  lna_denied: "ローカルネットワーク接続が拒否されました",
  health_timeout: "翻訳サーバへの接続がタイムアウトしました",
  health_network_error: "翻訳サーバへ接続できませんでした",
  health_http_error: "翻訳サーバが正常な応答を返しませんでした",
  health_invalid_response: "翻訳サーバの応答を確認できませんでした",
});

function mountPopup({
  documentApi = globalThis.document,
  chromeApi = globalThis.chrome,
  healthCheck = checkHealth,
} = {}) {
  const enabledInput = documentApi?.querySelector?.("#enabled");
  if (!enabledInput || !chromeApi?.storage?.local) return false;

  const statusElement = documentApi.querySelector("#status");
  const errorCodeElement = documentApi.querySelector("#error-code");
  const setEnabled = (value) => chromeApi.storage.local.set({ enabled: value });

  function showStatus(message, code = null) {
    if (statusElement) statusElement.textContent = message;
    if (!errorCodeElement) return;
    errorCodeElement.textContent = code ? `code: ${code}` : "";
    errorCodeElement.hidden = code === null;
  }

  async function loadState() {
    try {
      const state = await chromeApi.storage.local.get({ enabled: false });
      enabledInput.checked = state.enabled === true;
      showStatus(enabledInput.checked ? "有効" : "無効");
    } catch {
      enabledInput.checked = false;
      showStatus("設定を読み込めませんでした", "health_network_error");
    }
  }

  enabledInput.addEventListener("change", () => {
    if (!enabledInput.checked) {
      void disableTranslation({ setEnabled })
        .then(() => showStatus("無効"))
        .catch(() => showStatus("設定を保存できませんでした"));
      return;
    }

    enabledInput.disabled = true;
    showStatus("接続確認中…");
    void enableTranslation({ healthCheck, setEnabled })
      .then((state) => {
        enabledInput.checked = state.enabled;
        showStatus(state.enabled ? "有効" : STATUS_MESSAGES[state.error], state.error);
        enabledInput.disabled = false;
      })
      .catch(() => {
        enabledInput.checked = false;
        enabledInput.disabled = false;
        showStatus("設定を保存できませんでした");
      });
  });

  void loadState();
  return true;
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  mountPopup();
}
