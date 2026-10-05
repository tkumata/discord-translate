export const RECEIVED_CACHE_PREFIX = "receivedTranslation:v1:";
export const RECEIVED_CACHE_TTL_MS = 5 * 24 * 60 * 60 * 1000;
export const CACHE_STORAGE_TIMEOUT_MS = 5_000;

function validEntry(value) {
  return value?.version === 1 && typeof value.text === "string" &&
    value.text.trim().length > 0 && value.text.length <= 64 * 1024 &&
    Number.isFinite(value.savedAt) && value.savedAt >= 0 &&
    Number.isFinite(value.expiresAt) && value.expiresAt === value.savedAt + RECEIVED_CACHE_TTL_MS;
}

export function createReceivedTranslationCache(storage, {
  hashImpl, now = () => Date.now(),
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
} = {}) {
  let tail = Promise.resolve();
  let cleanupError = null;

  function run(operation, code) {
    let expired = false;
    const check = () => { if (expired) throw new Error(code); };
    // ponytail: serialize local storage operations; use per-key locks if contention matters.
    const task = tail.then(() => { check(); return operation(check); });
    tail = task.catch(() => {});
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutImpl(() => { expired = true; reject(new Error(code)); }, CACHE_STORAGE_TIMEOUT_MS);
      timer?.unref?.();
    });
    return Promise.race([task, timeout]).finally(() => clearTimeoutImpl(timer));
  }

  async function keyFor(message) {
    const hash = await hashImpl(JSON.stringify(["ja", message.text.trim()]));
    return `${RECEIVED_CACHE_PREFIX}${message.messageId}:${hash}`;
  }

  async function removeExpired(check) {
    try {
      const entries = await storage.get(null);
      check();
      const keys = Object.keys(entries).filter((key) => key.startsWith(RECEIVED_CACHE_PREFIX) &&
        (!validEntry(entries[key]) || now() >= entries[key].expiresAt));
      if (keys.length) await storage.remove(keys);
      check();
      cleanupError = null;
    } catch {
      cleanupError = "cache_cleanup_failed";
      check();
    }
  }

  return {
    async cleanup() {
      try { await run(removeExpired, "cache_cleanup_failed"); }
      catch { cleanupError = "cache_cleanup_failed"; }
      return cleanupError;
    },

    async lookup(message) {
      try {
        return await run(async (check) => {
          const key = await keyFor(message);
          check();
          const entries = await storage.get(key);
          check();
          const value = entries[key];
          if (validEntry(value) && now() < value.expiresAt) {
            return { status: "hit", text: value.text, error: cleanupError };
          }
          if (value !== undefined) {
            try { await storage.remove(key); }
            catch { cleanupError = "cache_cleanup_failed"; }
            check();
          }
          return { status: "miss", error: cleanupError };
        }, "cache_read_failed");
      } catch {
        return { status: "miss", error: "cache_read_failed" };
      }
    },

    async save(message, text, { signal } = {}) {
      try {
        return await run(async (check) => {
          const key = await keyFor(message);
          check();
          await removeExpired(check);
          const entries = await storage.get(key);
          check();
          if (signal?.aborted) return { saved: false, error: "cache_write_failed" };
          const previous = entries[key];
          const savedAt = validEntry(previous) && now() < previous.expiresAt ? previous.savedAt : now();
          const value = { version: 1, text, savedAt, expiresAt: savedAt + RECEIVED_CACHE_TTL_MS };
          const write = () => { check(); return storage.set({ [key]: value }); };
          try { await write(); }
          catch (cause) {
            if (!/quota/i.test(String(cause?.message))) throw cause;
            await removeExpired(check);
            await write();
          }
          check();
          return { saved: true, error: cleanupError };
        }, "cache_write_failed");
      } catch {
        return { saved: false, error: "cache_write_failed" };
      }
    },
  };
}
