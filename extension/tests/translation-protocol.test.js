import test from "node:test";
import assert from "node:assert/strict";
import { TranslationError, buildPayload, TranslationStream, validateMessage, validateResponse, validateSender } from "../translation-protocol.js";

test("validates trusted sender and exact translation input", () => {
  const sender = {
    id: "extension-id",
    frameId: 0,
    url: "https://discord.com/channels/1/2",
    tab: { id: 7 },
  };
  assert.equal(validateSender(sender, "extension-id"), true);
  assert.equal(validateSender({ ...sender, url: undefined }, "extension-id"), false);
  assert.equal(validateSender({ ...sender, frameId: 1 }, "extension-id"), false);
  assert.equal(validateSender({ ...sender, id: "other" }, "extension-id"), false);
  assert.equal(validateSender({ ...sender, url: "https://example.com/" }, "extension-id"), false);
  assert.equal(validateSender({ ...sender, tab: { id: 7, url: "https://discord.com/channels/1/2" }, url: undefined }, "extension-id"), false);

  assert.deepEqual(
    validateMessage({ type: "translate", messageId: "chat-messages-1-2", text: " hello " }),
    { messageId: "chat-messages-1-2", text: "hello", targetLanguage: "ja" },
  );
  assert.throws(
    () => validateMessage({ type: "translate", messageId: "chat-messages-1-2", text: " " }),
    (value) => value instanceof TranslationError && value.code === "invalid_input",
  );
  assert.throws(
    () => validateMessage({ type: "translate", messageId: "chat-messages-1-2", text: "x", extra: true }),
    (value) => value.code === "invalid_input",
  );
  assert.throws(
    () => validateMessage({ type: "translate", messageId: "not-a-message", text: "x" }),
    (value) => value.code === "invalid_input",
  );
});

test("builds the fixed non-thinking streaming payload with usage", () => {
  const payload = buildPayload("source");
  assert.equal(payload.messages[1].content, "source");
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.chat_template_kwargs.enable_thinking, false);
  assert.equal(payload.temperature, 0.7);
  assert.equal(payload.top_p, 0.8);
  assert.equal(payload.top_k, 20);
  assert.equal(payload.min_p, 0);
  assert.equal(payload.max_tokens, 1024);
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.equal("model" in payload, false);
});

test("validates response schema, finish reason, usage, and thinking markers", () => {
  assert.equal(validateResponse({
    choices: [{ finish_reason: "stop", message: { content: " 訳 " } }],
    usage: { total_tokens: 2 },
  }), "訳");
  for (const payload of [
    { choices: [], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "length", message: { content: "訳" } }], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "stop", message: { content: "" } }], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "stop", message: { content: "<THINK>hidden</THINK>" } }], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "stop", message: { content: "訳", reasoning: "hidden" } }], usage: { total_tokens: 1 } },
    { choices: [{ finish_reason: "stop", message: { content: "訳" } }], usage: {} },
  ]) {
    assert.throws(() => validateResponse(payload), (value) => value.code === "invalid_response");
  }
});

test("stream preserves whitespace and holds split thinking markers and surrogate pairs", () => {
  const progress = [];
  const stream = new TranslationStream((text) => progress.push(text));
  stream.push({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] });
  stream.push({ choices: [{ delta: { content: " 訳\n" } }] });
  stream.push({ choices: [{ delta: { content: "\uD83D" } }] });
  assert.equal(progress.at(-1), " 訳\n");
  stream.push({ choices: [{ delta: { content: "\uDE80" } }] });
  assert.equal(progress.at(-1), " 訳\n🚀");
  stream.push({ choices: [{ delta: { content: "<Th" } }] });
  assert.equal(progress.at(-1), " 訳\n🚀");
  assert.throws(() => stream.push({ choices: [{ delta: { content: "INK>secret" } }] }),
    (value) => value.code === "invalid_response");
});

test("stream rejects missing or duplicate completion metadata, tools and oversized content", () => {
  for (const chunks of [
    [],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }, { choices: [], usage: {} }],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }, { choices: [], usage: { total_tokens: -1 } }],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }, { choices: [], usage: { total_tokens: 1 } }, { choices: [], usage: { total_tokens: 1 } }],
    [{ choices: [{ delta: { content: "訳" }, finish_reason: "stop" }] }, { choices: [{ delta: { content: "after" } }] }],
    [{ choices: [{ delta: { reasoning_content: "private" } }] }],
    [{ choices: [{ delta: { tool_calls: [] } }] }],
    [{ choices: [{ delta: { role: "user" } }] }],
    [{ choices: [{ delta: { content: "x".repeat(64 * 1024 + 1) } }] }],
  ]) {
    assert.throws(() => {
      const stream = new TranslationStream();
      for (const chunk of chunks) stream.push(chunk);
      validateResponse(stream.response());
    }, (value) => value.code === "invalid_response");
  }
});
