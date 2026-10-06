import { BRIDGE_PORT_NAME } from "../bridge-registry.js";

export function responseFor(text, options) {
  options.onChunk({ choices: [{ delta: { content: `訳:${text}` }, finish_reason: "stop" }] });
  options.onChunk({ choices: [], usage: { total_tokens: 1 } });
  return { status: 200 };
}

export function completePort(port, text = "訳") {
  const jobId = port.messages.filter((message) => message.type === "translate").at(-1).jobId;
  port.receive({ type: "chunk", jobId, payload: {
    choices: [{ delta: { content: text }, finish_reason: "stop" }],
  } });
  port.receive({ type: "chunk", jobId, payload: { choices: [], usage: { total_tokens: 1 } } });
  port.receive({ type: "end", jobId });
}

export function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, ms) {
      const timer = { callback, ms, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.active = false;
    },
  };
}

export function diagnosticsLogger() {
  const calls = [];
  return {
    calls,
    logger: { warn(...args) { calls.push(args); } },
  };
}

export function fakePort(sender, name = BRIDGE_PORT_NAME) {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    name,
    sender,
    messages: [],
    disconnected: false,
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(message) { this.messages.push(message); },
    disconnect() {
      this.disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
    receive(message) {
      for (const listener of messageListeners) listener(message);
    },
  };
}
