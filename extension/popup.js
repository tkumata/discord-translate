import { COMPANION_URL, COMPANION_HEADERS, validateProvider } from "./translation-provider.js";

export const HEALTH_URL = "http://127.0.0.1:8080/health";
export const HEALTH_TIMEOUT_MS = 5_000;
export const HEALTH_ERROR_CODES = Object.freeze([
  "lna_denied",
  "health_timeout",
  "health_network_error",
  "health_http_error",
  "health_invalid_response",
  "chatgpt_not_connected",
  "chatgpt_unavailable",
  "local_unavailable",
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
  chatgpt_not_connected: "ChatGPT に接続し、利用枠の使用を許可してください",
  chatgpt_unavailable: "ChatGPT 用の補助プログラムを起動できません。自動起動の登録とポート8766を確認してください",
  local_unavailable: "ローカル翻訳サーバを起動できません。自動起動の登録、モデルの準備、ポート8080を確認してください",
});

export async function startTranslationServer(provider, runtime = globalThis.chrome.runtime) {
  validateProvider(provider);
  const started = await runtime.sendMessage({ type: "startTranslationServer", provider });
  if (started?.ok !== true) throw new Error(provider === "local" ? "local_unavailable" : "chatgpt_unavailable");
}

export async function requestCompanion(path, method = "GET", fetchImpl = globalThis.fetch) {
  if (!["/status", "/auth/start", "/auth/logout"].includes(path)) throw new Error("invalid_input");
  await startTranslationServer("chatgpt");
  const response = await fetchImpl(`${COMPANION_URL}${path}`, {
    method, headers: COMPANION_HEADERS, signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) throw new Error(response.status === 401 ? "chatgpt_not_connected" : "chatgpt_unavailable");
  return response.json();
}

export async function checkChatGPT(request = requestCompanion) {
  try {
    const status = await request("/status");
    return status?.connected === true && typeof status.model === "string" && status.model.length > 0
      ? { ok: true } : { ok: false, error: "chatgpt_not_connected" };
  } catch (value) {
    return { ok: false, error: value.message === "chatgpt_not_connected" ? "chatgpt_not_connected" : "chatgpt_unavailable" };
  }
}

export function mountPopup({
  documentApi = globalThis.document,
  chromeApi = globalThis.chrome,
  healthCheck = checkHealth,
  companionRequest = requestCompanion,
} = {}) {
  const enabledInput = documentApi?.querySelector?.("#enabled");
  if (!enabledInput || !chromeApi?.storage?.local) return false;

  const statusElement = documentApi.querySelector("#status");
  const errorCodeElement = documentApi.querySelector("#error-code");
  const setEnabled = (value) => chromeApi.storage.local.set({ enabled: value });
  const providerInput = documentApi.querySelector("#provider");
  const chatgptSection = documentApi.querySelector("#chatgpt");
  const accountStatus = documentApi.querySelector("#account-status");
  const connectButton = documentApi.querySelector("#connect");
  const disconnectButton = documentApi.querySelector("#disconnect");
  let provider = "local";

  function showProvider() {
    if (providerInput) providerInput.value = provider;
    if (chatgptSection) chatgptSection.hidden = provider !== "chatgpt";
  }

  async function refreshConnection() {
    const state = await companionRequest("/status");
    if (typeof state?.connected !== "boolean" ||
        (state.connected && (typeof state.model !== "string" || typeof state.account !== "string"))) {
      throw new Error("chatgpt_unavailable");
    }
    if (accountStatus) accountStatus.textContent = state.connected
      ? `接続済み: ${state.account} / ${state.model}` : "未接続";
    return state;
  }

  async function runAction(action) {
    const controls = [enabledInput, providerInput, connectButton, disconnectButton].filter(Boolean);
    controls.forEach((element) => { element.disabled = true; });
    try { await action(); }
    catch { showProvider(); showStatus("操作に失敗しました。補助プログラムと接続状態を確認してください"); }
    finally { controls.forEach((element) => { element.disabled = false; }); }
  }

  function showStatus(message, code = null) {
    if (statusElement) statusElement.textContent = message;
    if (!errorCodeElement) return;
    errorCodeElement.textContent = code ? `code: ${code}` : "";
    errorCodeElement.hidden = code === null;
  }

  async function loadState() {
    try {
      const state = await chromeApi.storage.local.get({ enabled: false, provider: "local" });
      provider = validateProvider(state.provider);
      showProvider();
      enabledInput.checked = state.enabled === true;
      showStatus(enabledInput.checked ? "有効" : "無効");
      if (provider === "chatgpt") {
        try { await refreshConnection(); }
        catch (value) { if (accountStatus) accountStatus.textContent = value.message === "chatgpt_not_connected"
          ? "ChatGPT に再接続してください" : "自動起動の登録とポート8766を確認してください"; }
      }
    } catch {
      enabledInput.checked = false;
      showStatus("設定を読み込めませんでした", "health_network_error");
    }
  }

  enabledInput.addEventListener("change", () => {
    void runAction(async () => {
      if (!enabledInput.checked) {
        await disableTranslation({ setEnabled });
        showStatus("無効");
        return;
      }
      showStatus("接続確認中…");
      try {
        const state = await enableTranslation({
          healthCheck: provider === "local" ? async () => {
            try { await startTranslationServer("local", chromeApi.runtime); }
            catch { return { ok: false, error: "local_unavailable" }; }
            return healthCheck();
          } : () => checkChatGPT(companionRequest), setEnabled,
        });
        enabledInput.checked = state.enabled;
        showStatus(state.enabled ? "有効" : STATUS_MESSAGES[state.error], state.error);
      } catch {
        enabledInput.checked = false;
        showStatus("設定を保存できませんでした");
      }
    });
  });

  providerInput?.addEventListener("change", () => {
    const next = providerInput.value;
    void runAction(async () => {
      validateProvider(next);
      await chromeApi.storage.local.set({ enabled: false, provider: next });
      provider = next;
      enabledInput.checked = false;
      showProvider();
      showStatus("無効。「Discord Translator を有効にする」を ON にすると選択した翻訳先を使用します");
      if (provider === "chatgpt") await refreshConnection();
    });
  });
  connectButton?.addEventListener("click", () => {
    void runAction(async () => {
      const state = await companionRequest("/auth/start", "POST");
      const url = new URL(state.url);
      if (url.origin !== COMPANION_URL || url.pathname !== "/auth/login" || url.hash || url.username || url.password) {
        throw new Error("invalid_response");
      }
      await chromeApi.tabs.create({ url: url.href });
      showStatus("認証後にポップアップを開き直し、「Discord Translator を有効にする」を ON にしてください");
    });
  });
  disconnectButton?.addEventListener("click", () => {
    void runAction(async () => {
      await setEnabled(false);
      enabledInput.checked = false;
      const state = await companionRequest("/auth/logout", "POST");
      if (state?.connected !== false || typeof state.revoked !== "boolean") throw new Error("invalid_response");
      if (accountStatus) accountStatus.textContent = "未接続";
      showStatus(state.revoked ? "切断しました" :
        "端末内の接続を削除しました。遠隔失効は未確認です。ChatGPT 設定でも接続を解除してください");
    });
  });

  void runAction(loadState);
  return true;
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  mountPopup();
}
