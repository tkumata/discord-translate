export const NATIVE_HOST_NAME = "com.discord_translate.chatgpt";

export function createNativeHelper(runtime) {
  let connection;
  return function ensureStarted() {
    if (connection) return connection.ready;
    let port;
    try { port = runtime.connectNative(NATIVE_HOST_NAME); }
    catch { return Promise.resolve({ ok: false }); }
    let resolve;
    let settled = false;
    const ready = new Promise((done) => { resolve = done; });
    connection = { port, ready };
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok });
    };
    const timeout = setTimeout(() => {
      finish(false);
      connection = undefined;
      port.disconnect();
    }, 15_000);
    port.onMessage.addListener((message) => {
      if (message?.type === "ready" && Object.keys(message).length === 1) finish(true);
      else { finish(false); port.disconnect(); }
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
