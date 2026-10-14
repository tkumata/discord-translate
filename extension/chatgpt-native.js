import { validateProvider } from "./translation-provider.js";

export const NATIVE_HOST_NAMES = Object.freeze({
  local: "com.discord_translate.local",
  chatgpt: "com.discord_translate.chatgpt",
});

export function createNativeHelper(runtime) {
  let connection;
  return function ensureStarted(provider) {
    validateProvider(provider);
    if (connection?.provider === provider) return connection.ready;
    connection?.close();
    let port;
    try { port = runtime.connectNative(NATIVE_HOST_NAMES[provider]); }
    catch { return Promise.resolve({ ok: false }); }
    let resolve;
    let settled = false;
    const ready = new Promise((done) => { resolve = done; });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok });
    };
    const close = () => {
      finish(false);
      if (connection?.port === port) connection = undefined;
      port.disconnect();
    };
    connection = { provider, port, ready, close };
    const timeout = setTimeout(close, provider === "local" ? 130_000 : 15_000);
    port.onMessage.addListener((message) => {
      if (message?.type === "ready" && Object.keys(message).length === 1) finish(true);
      else close();
    });
    port.onDisconnect.addListener(() => {
      // Read lastError inside the callback without logging browser-provided details.
      void runtime.lastError;
      if (connection?.port === port) connection = undefined;
      finish(false);
    });
    return ready;
  };
}
