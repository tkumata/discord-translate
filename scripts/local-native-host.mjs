import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runNativeHost } from "./chatgpt-native-host.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("start-server.sh", import.meta.url));

async function ownsListener(pid, signal) {
  try {
    const { stdout } = await exec("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid),
      "-iTCP:8080", "-sTCP:LISTEN", "-Fp"], { timeout: 2_000, signal });
    return stdout.split("\n").includes(`p${pid}`);
  } catch (value) {
    if (value.code === 1 && value.stdout === "" && value.stderr === "") return false;
    throw value;
  }
}

export async function startLocalServer(origin, {
  signal, onExit = () => {}, spawnImpl = spawn, timeoutMs = 120_000,
} = {}) {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new Error("invalid_origin");
  signal?.throwIfAborted();
  const env = { ...process.env, CORS_ORIGIN: origin, PORT: "8080" };
  // The script owns the default model; Chrome's inherited environment must not change it.
  delete env.MODEL;
  const child = spawnImpl(script, [], {
    env,
    // Keep Native stdout framed; the script and model verification share an owned process group.
    stdio: ["ignore", "ignore", "ignore"], detached: true,
  });
  const lifetime = new AbortController();
  let exited = false;
  let stopping;
  const ended = new Promise((resolve) => {
    const finish = () => {
      if (exited) return;
      exited = true;
      lifetime.abort();
      resolve();
      if (!stopping) onExit();
    };
    child.once("error", finish);
    child.once("exit", finish);
  });
  const killGroup = (name) => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, name); return true; }
    catch (value) { if (value.code !== "ESRCH") throw value; return false; }
  };
  function stop() {
    if (!stopping) stopping = (async () => {
      let failure;
      try { killGroup("SIGTERM"); }
      catch (value) { failure = value; }
      // Chrome may kill the Native host after two seconds; reap its group first.
      let timer;
      await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(resolve, 1_000); })]);
      clearTimeout(timer);
      // Descendants may survive the group leader; do not use signal 0 as an exit probe.
      try { killGroup("SIGKILL"); }
      catch (value) { failure ??= value; }
      await ended;
      if (failure) throw failure;
    })();
    return stopping;
  }
  const startupSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  try {
    while (true) {
      startupSignal.throwIfAborted();
      // /health alone could belong to a manually started server on the fixed port.
      if (await ownsListener(child.pid, startupSignal)) {
        const response = await fetch("http://127.0.0.1:8080/health", {
          signal: AbortSignal.any([startupSignal, AbortSignal.timeout(2_000)]),
        });
        const payload = await response.json();
        if (response.status !== 200 || payload?.status !== "ok" || Object.keys(payload).length !== 1) {
          throw new Error("local_health_failed");
        }
        startupSignal.throwIfAborted();
        if (!exited && await ownsListener(child.pid, startupSignal)) return stop;
      }
      await delay(200, undefined, { signal: startupSignal });
    }
  } catch (value) {
    await stop();
    throw value;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try { await runNativeHost(process.argv[2], { startServer: startLocalServer, signal: controller.signal }); }
  catch {
    console.error("local_native_start_failed: Native Messaging の登録、モデルの準備、ポート8080を確認してください。");
    process.exitCode = 1;
  }
}
