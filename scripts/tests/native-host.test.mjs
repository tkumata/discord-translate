import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { endianness, tmpdir } from "node:os";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { runNativeHost } from "../chatgpt-native-host.mjs";
import { startChatGPTServer } from "../chatgpt-server.mjs";

const exec = promisify(execFile);
const caller = "chrome-extension://jclieefodnikgckkglmnbeeiaejcgflo/";

test("native host emits one framed readiness message and stops the server on EOF or signal", async () => {
  for (const ending of ["eof", "signal"]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    let stopped = 0;
    const frame = once(output, "data");
    const done = runNativeHost(caller, { input, output, signal: controller.signal,
      startServer: async (origin) => {
        assert.equal(origin, caller.slice(0, -1));
        return () => { stopped++; };
      },
    });
    const [bytes] = await frame;
    const length = endianness() === "LE" ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0);
    assert.equal(bytes.length, length + 4);
    assert.deepEqual(JSON.parse(bytes.subarray(4)), { type: "ready" });
    if (ending === "eof") input.end();
    else controller.abort();
    await done;
    assert.equal(stopped, 1);
  }
});

test("native host rejects invalid origins and all input rather than accepting commands", async () => {
  let starts = 0;
  for (const origin of [undefined, "https://discord.com/", caller.slice(0, -1), `${caller}extra`]) {
    await assert.rejects(runNativeHost(origin, { startServer: async () => { starts++; } }), /invalid_origin/);
  }
  assert.equal(starts, 0);
  const input = new PassThrough();
  const output = new PassThrough();
  let stopped = 0;
  const frame = once(output, "data");
  const done = runNativeHost(caller, { input, output, startServer: async () => () => { stopped++; } });
  await frame;
  input.write(Buffer.from('{"command":"anything"}'));
  await assert.rejects(done, /invalid_native_input/);
  assert.equal(stopped, 1);
});

test("native disconnect during startup stops a late server without emitting ready", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let resolve;
  const starting = new Promise((done) => { resolve = done; });
  let frames = 0;
  let stopped = 0;
  output.on("data", () => { frames++; });
  const done = runNativeHost(caller, { input, output, startServer: () => starting });
  input.end();
  await new Promise((done) => setImmediate(done));
  resolve(() => { stopped++; });
  await done;
  assert.equal(stopped, 1);
  assert.equal(frames, 0);
});

test("native server startup failure emits no readiness and closes input", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let frames = 0;
  output.on("data", () => { frames++; });
  await assert.rejects(runNativeHost(caller, { input, output,
    startServer: async () => { throw new Error("occupied"); },
  }), /occupied/);
  assert.equal(frames, 0);
  assert.equal(input.destroyed, true);
});

test("duplicate listeners fail before opening credentials", async (t) => {
  const blocker = createServer();
  try {
    await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(8766, "127.0.0.1", resolve); });
    t.after(() => new Promise((resolve) => blocker.close(resolve)));
  } catch (value) {
    // An already-running helper also proves the fixed-port collision contract.
    if (value.code !== "EADDRINUSE") throw value;
  }
  let authCalls = 0;
  await assert.rejects(startChatGPTServer(caller.slice(0, -1), async () => { authCalls++; }), { code: "EADDRINUSE" });
  assert.equal(authCalls, 0);
});

test("macOS installer registers only the selected extension and a working absolute launcher", { skip: process.platform !== "darwin" }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "discord native's "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installer = fileURLToPath(new URL("../install-native-host.mjs", import.meta.url));
  const env = { ...process.env, HOME: home };
  const node = join(home, "node");
  await copyFile(process.execPath, node);
  await assert.rejects(exec(node, [installer, "invalid"], { env }), { code: 1 });
  const directory = join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  await exec(node, [installer, caller.split("/")[2]], { env });
  for (const provider of ["chatgpt", "local"]) {
    const name = `com.discord_translate.${provider}`;
    const manifest = JSON.parse(await readFile(join(directory, `${name}.json`), "utf8"));
    assert.deepEqual(manifest.allowed_origins, [caller]);
    assert.equal(manifest.name, name);
    assert.equal(manifest.type, "stdio");
    assert.equal(manifest.path, join(directory, `${name}.sh`));
    assert.equal((await stat(manifest.path)).mode & 0o777, 0o700);
    await assert.rejects(exec(manifest.path, ["https://discord.com/"], { env }), (value) => {
      assert.equal(value.code, 1);
      assert.equal(value.stdout, "");
      assert.match(value.stderr, new RegExp(`${provider}_native_start_failed`));
      return true;
    });
  }
});

test("nvm launchers survive updates and preserve native input, framing and shutdown", {
  skip: process.platform !== "darwin", timeout: 20000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "discord nvm's "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "node manager's");
  const project = join(home, "project's scripts");
  const binary = (version) => join(root, "versions", "node", `v${version}`, "bin", "node");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await mkdir(join(root, "alias", "lts"), { recursive: true });
  await writeFile(join(root, "nvm.sh"), "echo nvm_must_not_be_sourced; exit 99\n");
  await writeFile(join(root, "alias", "default"), "v24.0.0\n");
  await writeFile(join(root, "alias", "lts", "*"), "v99.0.0\n");
  await mkdir(project, { recursive: true });
  const installer = join(project, "install-native-host.mjs");
  await copyFile(fileURLToPath(new URL("../install-native-host.mjs", import.meta.url)), installer);
  const hostModule = pathToFileURL(fileURLToPath(new URL("../chatgpt-native-host.mjs", import.meta.url))).href;
  for (const provider of ["chatgpt", "local"]) {
    await writeFile(join(project, `${provider}-native-host.mjs`), `
import { runNativeHost } from ${JSON.stringify(hostModule)};
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
try {
  await runNativeHost(process.argv[2], { signal: controller.signal, startServer: async () => {
    console.error(JSON.stringify({ runtime: process.env.TEST_NODE_RUNTIME, args: process.argv.slice(2), pid: process.pid }));
    return () => console.error("server_stopped");
  } });
} catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  }
  await mkdir(join(binary("24.0.0"), ".."), { recursive: true });
  await copyFile(process.execPath, binary("24.0.0"));
  await exec(binary("24.0.0"), [installer, caller.split("/")[2]], { env: { ...process.env, HOME: home } });
  await rm(join(root, "versions", "node", "v24.0.0"), { recursive: true });

  // Fixture runtimes report release metadata, then execute the real native host.
  async function runtime(version, lts = true, broken = false) {
    await mkdir(join(binary(version), ".."), { recursive: true });
    await writeFile(`${binary(version)}.cjs`, `
Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
Object.defineProperty(process.release, "lts", { value: ${lts ? '"Fixture"' : "undefined"} });
`);
    await writeFile(binary(version), `#!/bin/sh
if [ "$1" = '-p' ]; then
  IFS= read -r unused || :
  ${broken ? "echo broken_runtime >&2; exit 3" : `exec ${quote(process.execPath)} --require ${quote(`${binary(version)}.cjs`)} "$@"`}
fi
export TEST_NODE_RUNTIME=${quote(version)}
exec ${quote(process.execPath)} "$@"
`, { mode: 0o700 });
  }
  for (const version of ["22.99.0", "24.9.0", "24.10.9", "24.10.10"]) await runtime(version);
  await runtime("28.0.0", false);
  await runtime("30.0.0", false, true);
  const directory = join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  const launcher = (provider) => join(directory, `com.discord_translate.${provider}.sh`);

  async function launch(provider, expected, ending) {
    const child = spawn(launcher(provider), [caller, "argument with ' quotes"], { env });
    const closed = once(child, "close");
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let stderr = "";
    let stdout = Buffer.alloc(0);
    let ready = false;
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    for await (const chunk of child.stdout) {
      stdout = Buffer.concat([stdout, chunk]);
      if (!ready && stdout.length >= 4) {
        const length = endianness() === "LE" ? stdout.readUInt32LE(0) : stdout.readUInt32BE(0);
        if (stdout.length < length + 4) continue;
        assert.equal(stdout.length, length + 4);
        assert.deepEqual(JSON.parse(stdout.subarray(4)), { type: "ready" });
        ready = true;
        if (ending === "signal") child.kill("SIGTERM");
        else child.stdin.end();
      }
    }
    assert.equal(ready, true);
    assert.deepEqual(await closed, [0, null]);
    assert.match(stderr, /native_host_node_probe_failed/);
    const info = JSON.parse(stderr.split("\n").find((line) => line.startsWith("{")));
    assert.deepEqual(info, { runtime: expected, args: [caller, "argument with ' quotes"], pid: child.pid });
    assert.match(stderr, /server_stopped/);
  }
  await launch("chatgpt", "24.10.10", "eof");
  await runtime("26.1.0");
  await launch("chatgpt", "26.1.0", "signal");
  await launch("local", "26.1.0", "eof");

  const invalidInput = exec(launcher("chatgpt"), [caller], { env });
  invalidInput.child.stdin.end("unexpected input\n");
  await assert.rejects(invalidInput, (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /invalid_native_input/);
    assert.match(error.stderr, /server_stopped/);
    return true;
  });
  for (const version of ["24.9.0", "24.10.9", "24.10.10", "26.1.0"]) {
    await rm(join(root, "versions", "node", `v${version}`), { recursive: true });
  }
  for (const provider of ["chatgpt", "local"]) {
    await assert.rejects(exec(launcher(provider), [caller], { env }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /native_host_node_unavailable/);
      return true;
    });
  }
  assert.equal(await readFile(join(root, "alias", "default"), "utf8"), "v24.0.0\n");
});
