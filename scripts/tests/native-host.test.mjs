import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { endianness, tmpdir } from "node:os";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
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
  await assert.rejects(exec(process.execPath, [installer, "invalid"], { env }), { code: 1 });
  const directory = join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  await exec(process.execPath, [installer, caller.split("/")[2]], { env });
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
