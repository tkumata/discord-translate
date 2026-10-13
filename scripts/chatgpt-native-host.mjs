import { endianness } from "node:os";
import { pathToFileURL } from "node:url";
import { startChatGPTServer } from "./chatgpt-server.mjs";

export function runNativeHost(caller, {
  input = process.stdin, output = process.stdout, startServer = startChatGPTServer,
  signal,
} = {}) {
  // Chrome supplies the allowed caller origin; no shell commands are accepted.
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(caller)) return Promise.reject(new Error("invalid_origin"));
  return new Promise((resolve, reject) => {
    let stop;
    let closed = false;
    function close(error) {
      if (closed) return;
      closed = true;
      stop?.();
      input.destroy();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    const abort = () => close();
    input.once("end", () => close());
    input.once("error", () => close(new Error("native_input_failed")));
    input.once("data", () => close(new Error("invalid_native_input")));
    output.once("error", () => close(new Error("native_output_failed")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { close(); return; }
    input.resume();
    void startServer(caller.slice(0, -1)).then((stopServer) => {
      stop = stopServer;
      if (closed) { stop(); return; }
      const body = Buffer.from(JSON.stringify({ type: "ready" }));
      const header = Buffer.alloc(4);
      if (endianness() === "LE") header.writeUInt32LE(body.length);
      else header.writeUInt32BE(body.length);
      output.write(Buffer.concat([header, body]));
    }).catch(close);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try { await runNativeHost(process.argv[2], { signal: controller.signal }); }
  catch {
    console.error("chatgpt_native_start_failed: Native Messaging の登録、ポート8766、認証ファイルを確認してください。");
    process.exitCode = 1;
  }
}
