function createReceivedMessages(openRequest) {
  const MESSAGE_CONTAINER_SELECTOR = 'li[id^="chat-messages-"]';
  const MESSAGE_CONTENT_SELECTOR = '[id^="message-content-"]';
  const MESSAGE_ID_PATTERN = /^chat-messages-[0-9]+-[0-9]+$/;
  const CONTENT_ID_PATTERN = /^message-content-[0-9]+$/;
  const CACHE_ERROR_CODES = new Set(["cache_read_failed", "cache_write_failed", "cache_cleanup_failed"]);
  let active = true;
  const messageRecords = new Map();

  function validContainer(container) {
    return container instanceof HTMLElement && MESSAGE_ID_PATTERN.test(container.id);
  }

  function findMessageContent(container) {
    const messageId = container.id.slice(container.id.lastIndexOf("-") + 1);
    const currentContentId = `message-content-${messageId}`;
    for (const content of container.querySelectorAll(MESSAGE_CONTENT_SELECTOR)) {
      if (!CONTENT_ID_PATTERN.test(content.id)) continue;
      if (content.id !== currentContentId) continue;
      if (content.closest(MESSAGE_CONTAINER_SELECTOR) === container) return content;
    }
    return null;
  }

  function normalizedContent(content) {
    const text = content.textContent?.trim() ?? "";
    return text.length > 0 && text.length <= MAX_TRANSLATION_INPUT_LENGTH ? text : null;
  }

  function removeRecordUi(record) {
    if (!record) return;
    record.ui?.remove();
    record.warning?.remove();
    record.warning = null;
    record.ui = null;
    record.translationLabel = null;
    record.translationBody = null;
  }

  function removeContainerUi(container) {
    for (const element of container.querySelectorAll("[data-discord-translate]")) element.remove();
  }

  function currentRecord(content, container, record) {
    return (
      active &&
      messageRecords.get(content) === record &&
      container.isConnected &&
      content.isConnected &&
      container.id === record.messageId &&
      container.contains(content) &&
      findMessageContent(container) === content &&
      content.textContent.trim() === record.text
    );
  }

  function showLoading(content, record) {
    removeRecordUi(record);
    const element = document.createElement("button");
    element.type = "button";
    element.disabled = true;
    element.dataset.discordTranslate = "loading";
    element.className = "discord-translate-loading";
    element.textContent = "翻訳中…";
    element.setAttribute("aria-live", "polite");
    content.after(element);
    record.ui = element;
  }

  function showButton(content, container, record) {
    removeRecordUi(record);
    const element = document.createElement("button");
    element.type = "button";
    element.dataset.discordTranslate = "button";
    element.className = "discord-translate-button";
    element.disabled = record.state === "lookup";
    element.textContent = record.state === "lookup" ? "確認中…" : "翻訳";
    element.addEventListener("click", () => requestTranslation(content, container));
    content.after(element);
    record.ui = element;
  }

  function showTranslation(content, record, translation, pending = false) {
    if (record.ui?.isConnected && record.ui.dataset.discordTranslate === "translation" &&
        record.translationLabel?.parentNode === record.ui && record.translationBody?.parentNode === record.ui) {
      record.translationLabel.textContent = pending ? "日本語訳（翻訳中…）" : "日本語訳";
      record.translationBody.textContent = translation;
      return;
    }
    removeRecordUi(record);
    const element = document.createElement("div");
    element.dataset.discordTranslate = "translation";
    element.className = "discord-translate-translation";
    element.lang = "ja";
    const label = document.createElement("span");
    label.className = "discord-translate-translation-label";
    label.textContent = pending ? "日本語訳（翻訳中…）" : "日本語訳";
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    const body = document.createElement("div");
    body.className = "discord-translate-translation-body";
    body.textContent = translation;
    element.append(label, body);
    record.translationLabel = label;
    record.translationBody = body;
    content.after(element);
    record.ui = element;
  }

  function showCacheWarning(record, code) {
    if (!CACHE_ERROR_CODES.has(code)) return;
    const warning = document.createElement("span");
    warning.dataset.discordTranslate = "cache-warning";
    warning.className = "discord-translate-error";
    const label = code === "cache_write_failed" ? "翻訳文を保存できませんでした" :
      code === "cache_read_failed" ? "保存した翻訳文を読み込めませんでした" : "期限切れの翻訳文を削除できませんでした";
    warning.textContent = `${label}（${code}）`;
    warning.setAttribute("role", "status");
    warning.setAttribute("aria-live", "polite");
    if (record.ui.dataset.discordTranslate === "translation") {
      record.ui.append(warning);
    } else {
      record.ui.after(warning);
      record.warning = warning;
    }
  }

  function showFailure(content, container, record, errorCode) {
    removeRecordUi(record);
    const element = document.createElement("div");
    element.dataset.discordTranslate = "error";
    element.className = "discord-translate-error";

    const message = document.createElement("span");
    message.textContent = `翻訳できませんでした（${errorCode}）`;
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "discord-translate-button";
    retry.textContent = "再試行";
    retry.addEventListener("click", () => requestTranslation(content, container, true));

    element.append(message, retry);
    content.after(element);
    record.ui = element;
  }

  function requestTranslation(content, container, retry = false) {
    if (!active || !container.isConnected || !content.isConnected) return;
    const text = normalizedContent(content);
    if (!text) return;

    const previous = messageRecords.get(content);
    if (!previous || !currentRecord(content, container, previous)) return;
    if (!retry && previous.state !== "idle") return;
    if (retry && previous.state !== "failed") return;

    const record = createMessageRecord(content, container, text, "pending");
    disposeMessageRecord(previous);
    messageRecords.set(content, record);
    showLoading(content, record);

    const fail = (code) => {
      record.close?.();
      if (!currentRecord(content, container, record)) return;
      record.state = "failed";
      showFailure(content, container, record, code);
    };
    const receive = (message) => {
      if (!currentRecord(content, container, record)) {
        disposeMessageRecord(record);
        return;
      }
      if (message.type === "progress") {
        showTranslation(content, record, message.text, true);
      } else {
        record.close?.();
        record.state = "succeeded";
        showTranslation(content, record, message.text.trim());
        showCacheWarning(record, message.cache?.error);
      }
    };
    record.close = openRequest({ type: "translate", messageId: container.id, text }, receive, fail);
  }

  function lookupTranslation(content, container, record) {
    let closed = false;
    const timer = setTimeout(() => finish({ status: "miss", error: "cache_read_failed" }), 5_000);
    timer?.unref?.();
    record.close = () => {
      closed = true;
      clearTimeout(timer);
    };
    const finish = (response) => {
      if (closed) return;
      record.close();
      if (!currentRecord(content, container, record)) return;
      const code = response?.error;
      if (validCacheHit(response)) {
        record.state = "succeeded";
        showTranslation(content, record, response.text);
        showCacheWarning(record, code);
      } else {
        record.state = "idle";
        showButton(content, container, record);
        showCacheWarning(record, validCacheMiss(response)
          ? code : "cache_read_failed");
      }
    };
    try {
      chrome.runtime.sendMessage({ type: "lookupTranslation", messageId: record.messageId, text: record.text }, (response) => {
        finish(chrome.runtime.lastError ? { status: "miss", error: "cache_read_failed" } : response);
      });
    } catch {
      finish({ status: "miss", error: "cache_read_failed" });
    }
  }

  function processContainer(container) {
    if (!active || !validContainer(container)) return;
    const content = findMessageContent(container);
    if (!content) {
      removeContainerUi(container);
      return;
    }
    const text = normalizedContent(content);
    const previous = messageRecords.get(content);

    if (!text) {
      disposeMessageRecord(previous);
      removeContainerUi(container);
      return;
    }
    if (previous && currentRecord(content, container, previous)) {
      if (previous.ui?.isConnected) return;
      if (previous.state === "pending" || previous.state === "lookup") {
        if (previous.state === "pending") showLoading(content, previous);
        else showButton(content, container, previous);
        return;
      }
    }
    disposeMessageRecord(previous);
    removeContainerUi(container);
    const record = createMessageRecord(content, container, text, "lookup");
    messageRecords.set(content, record);
    showButton(content, container, record);
    lookupTranslation(content, container, record);
  }

  function createMessageRecord(content, container, text, state) {
    return {
      container, content, messageId: container.id, text, state,
      ui: null, warning: null, translationLabel: null, translationBody: null, close: null,
    };
  }

  function disposeMessageRecord(record) {
    if (!record) return;
    record.close?.();
    removeRecordUi(record);
    if (messageRecords.get(record.content) === record) messageRecords.delete(record.content);
  }

  function validCacheResponse(response, status, expectedKeys) {
    return response?.status === status && responseKeys(response) === expectedKeys &&
      (response.error === null || CACHE_ERROR_CODES.has(response.error));
  }

  function responseKeys(value) {
    return value && typeof value === "object" ? Object.keys(value).sort().join(",") : "";
  }

  function validCacheHit(response) {
    return validCacheResponse(response, "hit", "error,status,text") &&
      typeof response.text === "string" && response.text.trim().length > 0 && response.text.length <= 64 * 1024;
  }

  function validCacheMiss(response) {
    return validCacheResponse(response, "miss", "error,status");
  }

  function scan() {
    if (!active) return;
    for (const record of messageRecords.values()) {
      if (!currentRecord(record.content, record.container, record)) disposeMessageRecord(record);
    }
    for (const container of document.querySelectorAll(MESSAGE_CONTAINER_SELECTOR)) processContainer(container);
  }

  function dispose() {
    active = false;
    for (const record of messageRecords.values()) disposeMessageRecord(record);
  }

  return { scan, dispose };
}
