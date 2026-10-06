import test from "node:test";
import assert from "node:assert/strict";
import { BridgeRegistry } from "../bridge-registry.js";
import { validateBridgePortSender } from "../translation-protocol.js";
import { fakePort } from "./worker-test-fixture.js";

test("accepts only the exact child bridge sender and routes a job to its tab", async () => {
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const sender = {
    id: "extension-id",
    frameId: 2,
    url: bridgeUrl,
    tab: { id: 7 },
  };
  assert.equal(validateBridgePortSender(sender, "extension-id", bridgeUrl), true);
  assert.equal(validateBridgePortSender({ ...sender, frameId: 0 }, "extension-id", bridgeUrl), false);
  assert.equal(validateBridgePortSender({ ...sender, url: "chrome-extension://other/bridge.html" }, "extension-id", bridgeUrl), false);
  assert.equal(validateBridgePortSender({ ...sender, tab: { id: 7.5 } }, "extension-id", bridgeUrl), false);

  const registry = new BridgeRegistry();
  const port = fakePort(sender);
  assert.equal(registry.connect(port, "extension-id", bridgeUrl), true);
  const pending = registry.request(7, { fixed: true });
  assert.equal(port.messages.length, 1);
  assert.equal(port.messages[0].type, "translate");
  assert.equal(typeof port.messages[0].jobId, "string");
  assert.deepEqual(port.messages[0].payload, { fixed: true });
  // The pending request remains open for multiple intermediate events.
  port.receive({ type: "chunk", jobId: port.messages[0].jobId, payload: { choices: [] } });
  assert.equal(registry.pending.size, 1);
  port.receive({ type: "end", jobId: port.messages[0].jobId });
  assert.deepEqual(await pending, { status: 200 });
});

test("does not route a content job to another tab and fails on bridge disconnect", async () => {
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const registry = new BridgeRegistry();
  const port = fakePort({ id: "extension-id", frameId: 1, url: bridgeUrl, tab: { id: 9 } });
  registry.connect(port, "extension-id", bridgeUrl);
  const pending = registry.request(9, { fixed: true });
  assert.equal(port.messages.length, 1);
  port.disconnect();
  await assert.rejects(pending, (value) => value.code === "bridge_unavailable");
  const abort = new AbortController();
  const wrongTab = registry.request(10, { fixed: true }, { signal: abort.signal });
  abort.abort();
  await assert.rejects(wrongTab, (value) => value.code === "request_timeout");
});

test("normalizes malformed bridge responses and bridge errors", async () => {
  const bridgeUrl = "chrome-extension://extension-id/bridge.html";
  const registry = new BridgeRegistry();
  const port = fakePort({ id: "extension-id", frameId: 1, url: bridgeUrl, tab: { id: 11 } });
  registry.connect(port, "extension-id", bridgeUrl);

  const malformed = registry.request(11, { fixed: true });
  port.receive({ type: "result", jobId: port.messages[0].jobId, status: 200 });
  await assert.rejects(malformed, (value) => value.code === "invalid_response");

  const denied = registry.request(11, { fixed: true });
  port.receive({ type: "error", jobId: port.messages.filter((message) => message.type === "translate").at(-1).jobId, error: "lna_denied" });
  await assert.rejects(denied, (value) => value.code === "lna_denied");
});
