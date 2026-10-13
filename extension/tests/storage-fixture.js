import { registerChromeListeners, REQUEST_PORT_NAME } from "../service-worker.js";
import { TranslationQueue } from "../translation-queue.js";
import { fakePort } from "./worker-test-fixture.js";

export async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export function storageFixture(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (keys === null) return structuredClone(data);
      const result = {};
      for (const key of typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)) {
        if (Object.hasOwn(data, key)) result[key] = structuredClone(data[key]);
        else if (typeof keys === "object" && !Array.isArray(keys)) result[key] = keys[key];
      }
      return result;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
}

export function workerFixture(storage, { cache, requestImpl } = {}) {
  let connect;
  let lookup;
  let calls = 0;
  const runtime = {
    id: "extension-id", getURL: (path) => `chrome-extension://extension-id/${path}`,
    onConnect: { addListener(listener) { connect = listener; } },
    onMessage: { addListener(listener) { lookup = listener; } },
    connectNative() {
      const port = fakePort();
      queueMicrotask(() => port.receive({ type: "ready" }));
      return port;
    },
  };
  const sender = { id: runtime.id, frameId: 0, url: "https://discord.com/channels/1/2", tab: { id: 1 } };
  const queue = new TranslationQueue({ requestImpl: async (...args) => {
    calls++;
    if (requestImpl) return requestImpl(...args);
    const [, payload, options] = args;
    options.onChunk({ choices: [{ delta: { content: `訳:${payload.messages[1].content}` }, finish_reason: "stop" }] });
    options.onChunk({ choices: [], usage: { total_tokens: 1 } });
    return { status: 200 };
  } });
  registerChromeListeners({ runtime, storage: { local: storage } }, queue, undefined, cache);
  return {
    queue, sender, get calls() { return calls; },
    lookup(message, from = sender) { return new Promise((resolve) => lookup(message, from, resolve)); },
    request(message, from = sender) {
      let receive;
      let disconnect;
      let resolve;
      const result = new Promise((done) => { resolve = done; });
      const port = {
        name: REQUEST_PORT_NAME, sender: from, messages: [], closed: false,
        onMessage: { addListener(listener) { receive = listener; } },
        onDisconnect: { addListener(listener) { disconnect = listener; } },
        postMessage(value) {
          this.messages.push(value);
          if (value.type !== "progress") resolve(value);
        },
        disconnect() { this.closed = true; disconnect?.(); },
      };
      connect(port);
      receive?.(message);
      return { port, result };
    },
  };
}
