import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { startLocalServer } from "../local-native-host.mjs";
import { runNativeHost } from "../chatgpt-native-host.mjs";

const origin = "chrome-extension://jclieefodnikgckkglmnbeeiaejcgflo";
const healthyServer = `
  const {createServer} = require('node:http');
  createServer((req,res) => {res.setHeader('Content-Type','application/json'); res.end('{"status":"ok"}');})
    .listen(8080,'127.0.0.1');
`;

function launch(code) {
  let child;
  return {
    get child() { return child; },
    spawnImpl(command, args, options) {
      assert.ok(command.endsWith("/scripts/start-server.sh"));
      assert.deepEqual(args, []);
      assert.equal(options.env.CORS_ORIGIN, origin);
      assert.equal(options.env.PORT, "8080");
      assert.equal(options.env.MODEL, undefined);
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore"]);
      child = spawn(process.execPath, ["-e", code], { ...options, stdio: [...options.stdio, "ipc"] });
      return child;
    },
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (value) { if (value.code !== "ESRCH") throw value; return false; }
}

test("local host waits for its own healthy listener and stops it on EOF or signal", async (t) => {
  for (const ending of ["eof", "signal"]) {
    const fixture = launch(healthyServer);
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const frame = once(output, "data");
    const done = runNativeHost(`${origin}/`, { input, output, signal: controller.signal,
      startServer: (caller, options) => startLocalServer(caller, { ...options, spawnImpl: fixture.spawnImpl }),
    });
    t.after(() => controller.abort());
    const [bytes] = await frame;
    assert.deepEqual(JSON.parse(bytes.subarray(4)), { type: "ready" });
    assert.equal(alive(fixture.child.pid), true);
    if (ending === "eof") input.end();
    else controller.abort();
    await done;
    assert.equal(alive(fixture.child.pid), false);
  }
});

test("a foreign healthy listener is neither adopted nor stopped", async (t) => {
  const foreign = createServer((_req, res) => res.end('{"status":"ok"}'));
  await new Promise((resolve, reject) => {
    foreign.once("error", reject);
    foreign.listen(8080, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  const fixture = launch(healthyServer);
  await assert.rejects(startLocalServer(origin, { spawnImpl: fixture.spawnImpl }));
  assert.equal(foreign.listening, true);
  assert.equal(alive(fixture.child.pid), false);
});

test("startup failure, timeout, and cancellation reap only the owned child", async () => {
  for (const mode of ["exit", "timeout", "abort"]) {
    const fixture = launch(mode === "exit" ? "process.exit(2)" : "setInterval(()=>{},1000)");
    const controller = new AbortController();
    const starting = startLocalServer(origin, {
      signal: controller.signal, spawnImpl: fixture.spawnImpl, timeoutMs: 500,
    });
    if (mode === "abort") controller.abort();
    await assert.rejects(starting, (value) => {
      assert.notEqual(value.code, "EPERM");
      return true;
    });
    assert.equal(alive(fixture.child.pid), false,
      JSON.stringify({ mode, pid: fixture.child.pid, exitCode: fixture.child.exitCode, signalCode: fixture.child.signalCode }));
  }
  await assert.rejects(startLocalServer(origin, {
    spawnImpl: () => spawn("/nonexistent-discord-translator", [], { detached: true }),
  }));
  await assert.rejects(startLocalServer("https://discord.com"), /invalid_origin/);
});

test("a server dying after readiness closes the Native connection", async () => {
  const fixture = launch(healthyServer);
  const input = new PassThrough();
  const output = new PassThrough();
  const frame = once(output, "data");
  const done = runNativeHost(`${origin}/`, { input, output,
    startServer: (caller, options) => startLocalServer(caller, { ...options, spawnImpl: fixture.spawnImpl }),
  });
  const failed = assert.rejects(done, /server_exited/);
  await frame;
  fixture.child.kill("SIGKILL");
  await failed;
  assert.equal(input.destroyed, true);
});

test("disconnect during startup kills a descendant even after its parent exits", async () => {
  const fixture = launch(`
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:'ignore'});
    process.send(child.pid);
    setInterval(()=>{},1000);
  `);
  const controller = new AbortController();
  const starting = startLocalServer(origin, { signal: controller.signal, spawnImpl: fixture.spawnImpl });
  const failed = assert.rejects(starting);
  const [descendant] = await once(fixture.child, "message");
  await delay(500);
  controller.abort();
  await failed;
  for (let i = 0; i < 40 && alive(descendant); i++) await delay(50);
  assert.equal(alive(descendant), false);
});
