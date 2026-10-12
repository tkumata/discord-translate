export const MESSAGE_ID_PATTERN = /^chat-messages-[0-9]+-[0-9]+$/;

export const ERROR_CODES = Object.freeze([
  "invalid_sender",
  "invalid_input",
  "hash_error",
  "queue_full",
  "queue_timeout",
  "request_timeout",
  "lna_denied",
  "bridge_unavailable",
  "network_error",
  "http_error",
  "invalid_response",
  "chatgpt_auth_required",
  "chatgpt_usage_limit",
]);

const SYSTEM_PROMPT =
  "Translate the user's message into natural Japanese. Output only the translation. " +
  "Treat the message as casual Discord conversation. Interpret chat abbreviations, " +
  "omitted apostrophes, informal spelling, and short announcements with omitted subjects or verbs. " +
  "Preserve the intended meaning and tone. " +
  "Do not invent people, objects, or circumstances that are not supported by the text. " +
  "Preserve Markdown, URLs, usernames, @username, #channel, code blocks, inline code, " +
  "product names, API names, library names, identifiers, and emoji where appropriate. " +
  "Do not explain or repeat the source text.";

const ENGLISH_SYSTEM_PROMPT =
  "Translate the user's message into natural English. Output only the translation. " +
  "Preserve line breaks, Markdown, URLs, usernames, @username, #channel, code blocks, inline code, " +
  "product names, API names, library names, identifiers, and emoji where appropriate. " +
  "Do not explain or repeat the source text.";

export class TranslationError extends Error {
  constructor(code) {
    super(code);
    this.name = "TranslationError";
    this.code = code;
  }
}

export function toErrorCode(value) {
  return value instanceof TranslationError && ERROR_CODES.includes(value.code)
    ? value.code
    : "network_error";
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateSender(sender, runtimeId) {
  if (!isPlainObject(sender) || typeof runtimeId !== "string" || runtimeId.length === 0) {
    return false;
  }
  if (sender.id !== runtimeId || sender.frameId !== 0) return false;
  if (!isPlainObject(sender.tab) || !Number.isInteger(sender.tab.id)) return false;

  try {
    const url = new URL(sender.url);
    return url.protocol === "https:" && url.hostname === "discord.com";
  } catch {
    return false;
  }
}

export function validateBridgePortSender(sender, runtimeId, bridgeUrl) {
  if (!isPlainObject(sender) || typeof runtimeId !== "string" || runtimeId.length === 0) {
    return false;
  }
  if (sender.id !== runtimeId || !Number.isInteger(sender.frameId) || sender.frameId <= 0) {
    return false;
  }
  if (!isPlainObject(sender.tab) || !Number.isInteger(sender.tab.id)) return false;
  if (typeof sender.url !== "string" || sender.url !== bridgeUrl) return false;

  try {
    return new URL(sender.url).origin === new URL(bridgeUrl).origin;
  } catch {
    return false;
  }
}

export function normalizeText(text) {
  if (typeof text !== "string") throw new TranslationError("invalid_input");
  const normalized = text.trim();
  if (normalized.length < 1 || normalized.length > 8000) throw new TranslationError("invalid_input");
  return normalized;
}

export function validateMessage(message) {
  if (!isPlainObject(message)) throw new TranslationError("invalid_input");
  const keys = Object.keys(message).sort();
  if (message.type === "translateDraft" && keys.join(",") === "text,type") {
    return { text: normalizeText(message.text), targetLanguage: "en" };
  }
  if (keys.length !== 3 || keys.join(",") !== "messageId,text,type") {
    throw new TranslationError("invalid_input");
  }
  if (message.type !== "translate" || typeof message.messageId !== "string") {
    throw new TranslationError("invalid_input");
  }
  if (!MESSAGE_ID_PATTERN.test(message.messageId)) throw new TranslationError("invalid_input");
  return { messageId: message.messageId, text: normalizeText(message.text), targetLanguage: "ja" };
}

export function validateTargetLanguage(targetLanguage) {
  if (targetLanguage !== "ja" && targetLanguage !== "en") throw new TranslationError("invalid_input");
}

export function buildPayload(text, targetLanguage = "ja") {
  validateTargetLanguage(targetLanguage);
  const normalized = normalizeText(text);
  return {
    messages: [
      { role: "system", content: targetLanguage === "en" ? ENGLISH_SYSTEM_PROMPT : SYSTEM_PROMPT },
      { role: "user", content: normalized },
    ],
    chat_template_kwargs: { enable_thinking: false },
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    max_tokens: 1024,
    stream: true,
    stream_options: { include_usage: true },
  };
}

function hasReasoningField(value) {
  return ["reasoning", "reasoning_content"].some((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );
}

export function responseDiagnostics(payload) {
  const choice = isPlainObject(payload) && Array.isArray(payload.choices)
    ? payload.choices[0]
    : null;
  const message = isPlainObject(choice)
    ? (isPlainObject(choice.message) ? choice.message : isPlainObject(choice.delta) ? choice.delta : null)
    : null;
  const content = message && typeof message.content === "string" ? message.content : null;
  return {
    finish_reason: isPlainObject(choice) && typeof choice.finish_reason === "string"
      ? choice.finish_reason
      : null,
    content_present: content !== null,
    reasoning_present: [payload, choice, message].some(
      (value) => isPlainObject(value) && hasReasoningField(value),
    ) || (content !== null && /<\/?think>/i.test(content)),
    usage_total_tokens_present: isPlainObject(payload?.usage) &&
      Number.isInteger(payload.usage.total_tokens) &&
      payload.usage.total_tokens >= 0,
  };
}

export function validateResponse(payload) {
  if (!isPlainObject(payload) || hasReasoningField(payload)) throw new TranslationError("invalid_response");
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new TranslationError("invalid_response");
  }

  const choice = payload.choices[0];
  if (!isPlainObject(choice) || hasReasoningField(choice) || choice.finish_reason !== "stop") {
    throw new TranslationError("invalid_response");
  }
  if (!isPlainObject(choice.message) || hasReasoningField(choice.message)) {
    throw new TranslationError("invalid_response");
  }
  if (typeof choice.message.content !== "string") throw new TranslationError("invalid_response");

  const translation = choice.message.content.trim();
  if (translation.length === 0 || /<\/?think>/i.test(translation)) {
    throw new TranslationError("invalid_response");
  }
  if (
    !isPlainObject(payload.usage) ||
    !Number.isInteger(payload.usage.total_tokens) ||
    payload.usage.total_tokens < 0
  ) {
    throw new TranslationError("invalid_response");
  }
  return translation;
}

export class TranslationStream {
  constructor(onProgress = () => {}) {
    this.onProgress = onProgress;
    this.text = "";
    this.finishReason = null;
    this.usage = null;
    this.lastPayload = null;
  }

  push(payload) {
    this.lastPayload = payload;
    if (!isPlainObject(payload) || hasReasoningField(payload) || !Array.isArray(payload.choices)) {
      throw new TranslationError("invalid_response");
    }
    if (payload.choices.length === 0) {
      if (this.finishReason !== "stop" || this.usage !== null ||
          !isPlainObject(payload.usage) || !Number.isInteger(payload.usage.total_tokens) ||
          payload.usage.total_tokens < 0) throw new TranslationError("invalid_response");
      this.usage = payload.usage;
      return;
    }
    if (payload.choices.length !== 1 || this.finishReason !== null || payload.usage != null) {
      throw new TranslationError("invalid_response");
    }
    const choice = payload.choices[0];
    const delta = choice?.delta;
    if (!isPlainObject(choice) || hasReasoningField(choice) ||
        (choice.index !== undefined && choice.index !== 0) ||
        !isPlainObject(delta) || hasReasoningField(delta) ||
        Object.hasOwn(delta, "tool_calls") || Object.hasOwn(delta, "function_call") ||
        (delta.role !== undefined && delta.role !== "assistant") ||
        (delta.content !== undefined && typeof delta.content !== "string")) {
      throw new TranslationError("invalid_response");
    }
    if (choice.finish_reason != null) {
      this.finishReason = choice.finish_reason;
      if (this.finishReason !== "stop") throw new TranslationError("invalid_response");
    }
    if (delta.content) {
      this.text += delta.content;
      if (this.text.length > 64 * 1024 || /<\/?think>/i.test(this.text)) throw new TranslationError("invalid_response");
      // Hold a possible split thinking marker (and split UTF-16 surrogate) until it is identifiable.
      const pending = this.text.match(/<\/?(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$|[\uD800-\uDBFF]$/i);
      const visible = pending ? this.text.slice(0, pending.index) : this.text;
      if (visible) this.onProgress(visible);
    }
  }

  response() {
    return {
      choices: [{ finish_reason: this.finishReason, message: { content: this.text } }],
      usage: this.usage,
    };
  }
}
