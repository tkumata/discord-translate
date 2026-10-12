import { TranslationError } from "./translation-protocol.js";

export const COMPANION_URL = "http://127.0.0.1:8766";
export const COMPANION_HEADERS = Object.freeze({ "X-Discord-Translate": "1" });

export function validateProvider(provider) {
  if (provider !== "local" && provider !== "chatgpt") throw new TranslationError("invalid_input");
  return provider;
}

export async function readProvider(storage) {
  const state = await storage.get({ provider: "local" });
  return validateProvider(state.provider);
}

export function translationCacheSource(provider, language, text) {
  validateProvider(provider);
  return JSON.stringify(provider === "local" ? [language, text] : [provider, language, text]);
}
