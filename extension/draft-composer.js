function createDraftComposer(openRequest) {
  const COMPOSER_SELECTOR = '[role="textbox"][contenteditable="true"][data-slate-editor="true"]';
  const MESSAGE_CONTAINER_SELECTOR = 'li[id^="chat-messages-"]';
  let active = true;
  const composers = new Map();

  function composerText(editor) {
    if (editor.querySelectorAll('[contenteditable="false"], [data-slate-void], [data-slate-inline], img, svg').length) {
      return null;
    }
    const blocks = [...editor.children];
    if (!blocks.length || blocks.some((block) => block.getAttribute("data-slate-node") !== "element")) return null;
    const lines = [];
    for (const block of blocks) {
      const leaves = [...block.querySelectorAll("[data-slate-string], [data-slate-zero-width]")];
      if (!leaves.length) return null;
      lines.push(leaves.map((leaf, index) => {
        if (leaf.hasAttribute("data-slate-zero-width")) return "";
        // Slate renders an extra trailing LF to keep a final line break visible.
        const text = leaf.textContent;
        return index === leaves.length - 1 && text.endsWith("\n\n") ? text.slice(0, -1) : text;
      }).join(""));
    }
    return lines.join("\n");
  }

  function currentComposer(record) {
    return active && composers.get(record.editor) === record && record.editor.isConnected &&
      record.editor.closest("form") === record.form && location.pathname === record.path;
  }

  function cancelComposerRequest(record) {
    record.close?.();
    record.close = null;
    record.pending = false;
  }

  function refreshComposer(record) {
    const text = composerText(record.editor);
    record.text = text;
    if (text !== null && !text.trim()) record.original = null;
    const reason = text === null ? "メンションなどを含む下書きは翻訳できません。" :
      text.trim().length > MAX_TRANSLATION_INPUT_LENGTH ? "下書きは8,000文字以内にしてください。" : "";
    const label = record.pending ? "翻訳中…" : "英語に翻訳";
    if (record.translateButton.textContent !== label) record.translateButton.textContent = label;
    record.translateButton.disabled = record.pending || record.applying || record.composing ||
      text === null || !text.trim() || text.trim().length > MAX_TRANSLATION_INPUT_LENGTH;
    record.restoreButton.hidden = record.original === null;
    record.restoreButton.disabled = record.pending || record.applying || record.composing || text === null;
    const status = reason || record.status;
    if (record.statusElement.textContent !== status) record.statusElement.textContent = status;
  }

  function disposeComposer(record) {
    cancelComposerRequest(record);
    for (const [type, listener] of record.listeners) record.editor.removeEventListener(type, listener, true);
    record.original = null;
    record.ui.remove();
    composers.delete(record.editor);
  }

  function composerEdited(record) {
    if (record.applying) return;
    record.generation++;
    cancelComposerRequest(record);
    record.status = "";
    refreshComposer(record);
  }

  async function replaceComposerText(record, text) {
    if (!currentComposer(record) || record.composing || composerText(record.editor) === null) return false;
    record.applying = true;
    refreshComposer(record);
    try {
      record.editor.focus();
      const range = document.createRange();
      range.selectNodeContents(record.editor);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new DataTransfer();
      data.setData("text/plain", text);
      record.editor.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, composed: true,
        inputType: "insertFromPaste", dataTransfer: data,
        targetRanges: [new StaticRange({
          startContainer: range.startContainer, startOffset: range.startOffset,
          endContainer: range.endContainer, endOffset: range.endOffset,
        })],
      }));
      // Yield to the editor's state update without waiting for a visible-tab animation frame.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return currentComposer(record) && composerText(record.editor) === text;
    } catch {
      return false;
    } finally {
      record.applying = false;
      record.generation++;
    }
  }

  async function restoreComposer(record) {
    if (!currentComposer(record) || record.pending || record.applying || record.composing || record.original === null) return;
    const restored = await replaceComposerText(record, record.original);
    if (!currentComposer(record)) return;
    record.status = restored ? "翻訳前の下書きに戻しました。" : "下書きを更新できませんでした。";
    if (restored) record.original = null;
    refreshComposer(record);
  }

  function requestDraftTranslation(record) {
    if (!currentComposer(record) || record.pending || record.applying || record.composing) return;
    const source = composerText(record.editor);
    if (source === null || !source.trim() || source.trim().length > MAX_TRANSLATION_INPUT_LENGTH) return;
    const generation = record.generation;
    const isCurrent = () => currentComposer(record) && record.generation === generation &&
      composerText(record.editor) === source;
    record.pending = true;
    record.status = "";
    refreshComposer(record);
    const fail = (code) => {
      if (!isCurrent()) return;
      cancelComposerRequest(record);
      record.status = `翻訳できませんでした（${code}）`;
      refreshComposer(record);
    };
    record.close = openRequest({ type: "translateDraft", text: source.trim() }, async (message) => {
      if (!isCurrent()) {
        cancelComposerRequest(record);
        if (currentComposer(record)) refreshComposer(record);
        return;
      }
      if (message.type === "progress") return;
      cancelComposerRequest(record);
      const previousOriginal = record.original;
      record.original = source;
      const replaced = await replaceComposerText(record, message.text.trim());
      if (!currentComposer(record)) return;
      record.status = replaced ? "英語の下書きに変換しました。" : "下書きを更新できませんでした。";
      if (!replaced && composerText(record.editor) === source) record.original = previousOriginal;
      refreshComposer(record);
    }, fail);
  }

  function scanComposers() {
    for (const record of composers.values()) {
      if (!currentComposer(record)) disposeComposer(record);
      else if (!record.applying && composerText(record.editor) !== record.text) composerEdited(record);
    }
    for (const editor of document.querySelectorAll(COMPOSER_SELECTOR)) {
      const form = editor.closest("form");
      if (!form || editor.closest(MESSAGE_CONTAINER_SELECTOR) || editor.closest('[role="dialog"]') ||
          !/^\/channels\/(?:@me|[0-9]+)\/[0-9]+(?:\/[0-9]+)?\/?$/.test(location.pathname)) continue;
      if (composers.has(editor)) continue;
      attachComposer(editor, form);
    }
  }
  function attachComposer(editor, form) {
    const ui = document.createElement("div");
    ui.dataset.discordTranslate = "composer";
    ui.className = "discord-translate-composer";
    const translateButton = document.createElement("button");
    const restoreButton = document.createElement("button");
    for (const button of [translateButton, restoreButton]) {
      button.type = "button";
      button.className = "discord-translate-button";
    }
    restoreButton.textContent = "元に戻す";
    const statusElement = document.createElement("span");
    statusElement.setAttribute("role", "status");
    statusElement.setAttribute("aria-live", "polite");
    ui.append(translateButton, restoreButton, statusElement);
    form.appendChild(ui);
    const record = {
      editor, form, path: location.pathname, ui, translateButton, restoreButton, statusElement,
      generation: 0, original: null, pending: false, applying: false, composing: false, status: "", listeners: [],
    };
    const edit = () => composerEdited(record);
    record.listeners = [
      ["beforeinput", edit], ["input", edit],
      ["compositionstart", () => { record.composing = true; composerEdited(record); }],
      ["compositionend", () => { record.composing = false; composerEdited(record); }],
    ];
    for (const [type, listener] of record.listeners) editor.addEventListener(type, listener, true);
    translateButton.addEventListener("click", () => requestDraftTranslation(record));
    restoreButton.addEventListener("click", () => { void restoreComposer(record); });
    composers.set(editor, record);
    refreshComposer(record);
  }

  function dispose() {
    active = false;
    for (const record of composers.values()) disposeComposer(record);
  }

  return { scan: scanComposers, dispose };
}
