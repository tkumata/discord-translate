import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const randomValue = () => randomBytes(32).toString("base64url");
const fail = (code) => { throw new Error(code); };

export async function readJsonResponse(response) {
  if (!response.ok || !response.body) fail("chatgpt_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) fail("invalid_response");
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function verifyIdentity(token, jwks, { clientId, nonce, now = Date.now() }) {
  if (typeof token !== "string" || token.length > 32 * 1024) fail("invalid_identity");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) fail("invalid_identity");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.crit !== undefined) fail("invalid_identity");
  const keys = jwks?.keys?.filter((key) => key.kid === header.kid && key.kty === "RSA" &&
    (key.alg === undefined || key.alg === header.alg) && (key.use === undefined || key.use === "sig") &&
    (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes("verify"))));
  if (keys?.length !== 1) fail("invalid_identity");
  const key = createPublicKey({ key: keys[0], format: "jwk" });
  if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key,
    Buffer.from(parts[2], "base64url"))) fail("invalid_identity");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const seconds = now / 1000;
  if (claims.iss !== ISSUER || !audience.includes(clientId) ||
      (audience.length > 1 && claims.azp !== clientId) ||
      !Number.isInteger(claims.exp) || claims.exp <= seconds ||
      !Number.isInteger(claims.iat) || claims.iat > seconds + 5 ||
      (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > seconds + 5)) ||
      (nonce !== undefined && claims.nonce !== nonce) ||
      typeof claims.sub !== "string" || !claims.sub) fail("invalid_identity");
  return claims;
}

function hasPlanScope(scope) {
  const scopes = typeof scope === "string" ? scope.split(/\s+/) : [];
  return ["resource.invoke", "chatgpt.tokens.use.direct"].every((value) => scopes.includes(value));
}

function tokenSet(response, previous, now) {
  if (typeof response?.token_type !== "string" || response.token_type.toLowerCase() !== "bearer" ||
      typeof response.access_token !== "string" || !response.access_token ||
      typeof response.refresh_token !== "string" || !response.refresh_token ||
      !Number.isInteger(response.expires_in) || response.expires_in <= 0) fail("invalid_tokens");
  const scope = response.scope === undefined ? previous?.scope : response.scope;
  if (!hasPlanScope(scope)) fail("chatgpt_auth_required");
  const idToken = response.id_token ?? previous?.idToken;
  if (typeof idToken !== "string" || !idToken) fail("invalid_tokens");
  return { accessToken: response.access_token, refreshToken: response.refresh_token, idToken,
    scope, expiresAt: now + response.expires_in * 1000 };
}

export async function createChatGPTAuth({
  directory = join(homedir(), ".config", "discord-translate"),
  callbackOrigin = "http://127.0.0.1:8766",
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const filename = join(directory, "chatgpt.json");
  let state;
  try { state = JSON.parse(await readFile(filename, "utf8")); }
  catch (value) {
    if (value.code !== "ENOENT") fail("credential_read_failed");
    state = { hostId: `urn:uuid:${randomUUID()}`, registration: null, tokens: null, model: null };
  }
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(state?.hostId) ||
      (state.registration !== null && (typeof state.registration?.clientId !== "string" ||
        !state.registration.clientId.startsWith("oaiapp_") || typeof state.registration.subject !== "string" ||
        !state.registration.subject || typeof state.registration.label !== "string")) ||
      (state.tokens !== null && (!state.registration || !Number.isFinite(state.tokens.expiresAt) ||
        !hasPlanScope(state.tokens.scope) || ["accessToken", "refreshToken", "idToken"].some(
          (key) => typeof state.tokens[key] !== "string" || !state.tokens[key]))) ||
      (state.tokens !== null && !state.model) ||
      (state.model !== null && (typeof state.model !== "string" || !state.model))) fail("credential_read_failed");
  let generation = 0;
  let pending = null;
  let refreshing = null;
  let storageTail = Promise.resolve();
  let metadata = null;
  const activeRequests = new Set();

  async function commit(next, expected, erase = false) {
    const task = storageTail.then(async () => {
      if (!erase && expected !== generation) fail("auth_cancelled");
      const temporary = `${filename}.${randomValue()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        // Serialize the rename with logout; a superseded network result cannot restore tokens.
        if (!erase && expected !== generation) fail("auth_cancelled");
        await rename(temporary, filename);
        if (expected === generation) state = next;
      } finally {
        await unlink(temporary).catch((value) => { if (value.code !== "ENOENT") throw value; });
      }
    });
    storageTail = task.catch(() => {});
    await task;
  }
  await commit(state, generation);

  async function jsonRequest(url, options = {}) {
    const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(10_000) });
    return readJsonResponse(response);
  }

  async function discovery() {
    if (metadata) return metadata;
    const result = await jsonRequest(`${ISSUER}/.well-known/openid-configuration`);
    if (result.issuer !== ISSUER) fail("invalid_identity");
    for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri", "revocation_endpoint"]) {
      const url = new URL(result[field]);
      if (url.origin !== ISSUER || url.username || url.password || url.hash) fail("invalid_identity");
    }
    metadata = result;
    return result;
  }

  async function identity(token, clientId, nonce) {
    const config = await discovery();
    const jwks = await jsonRequest(config.jwks_uri);
    return verifyIdentity(token, jwks, { clientId, nonce, now: now() });
  }

  async function exchange(parameters) {
    const config = await discovery();
    const response = await fetchImpl(config.token_endpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...parameters, resource: RESOURCE }),
      signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (response.status === 400 || response.status === 401) fail("chatgpt_auth_required");
    return readJsonResponse(response);
  }

  async function modelFor(tokens) {
    const result = await jsonRequest(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    const model = result.models?.find((value) => value.visibility === "list" && typeof value.slug === "string" && value.slug);
    if (!model) fail("chatgpt_unavailable");
    return model.slug;
  }

  async function access() {
    if (!state.tokens) fail("chatgpt_auth_required");
    if (state.tokens.expiresAt > now() + 60_000) return { ...state.tokens, model: state.model };
    if (!refreshing) {
      const expected = generation;
      const original = state;
      refreshing = (async () => {
        const response = await exchange({ grant_type: "refresh_token", client_id: original.registration.clientId,
          refresh_token: original.tokens.refreshToken });
        const tokens = tokenSet(response, original.tokens, now());
        if (response.id_token !== undefined) {
          const claims = await identity(response.id_token, original.registration.clientId);
          if (claims.sub !== original.registration.subject) fail("invalid_identity");
        }
        await commit({ ...original, tokens }, expected);
        if (expected !== generation || !state.tokens) fail("auth_cancelled");
        return { ...tokens, model: original.model };
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  return {
    async start() {
      const expected = ++generation;
      pending = null;
      const config = await discovery();
      if (expected !== generation) fail("auth_cancelled");
      const transaction = { generation: expected, state: randomValue(), nonce: randomValue(), verifier: randomValue(),
        expiresAt: now() + 10 * 60_000, registration: state.registration };
      const url = new URL(config.authorization_endpoint);
      url.search = new URLSearchParams({ client_id: transaction.registration?.clientId ?? "dynamic_agent_client",
        ...(!transaction.registration ? { agent_name_hint: "Discord Local Translator" } : {}),
        ext_agent_host_id: state.hostId, response_type: "code", redirect_uri: `${callbackOrigin}/auth/callback`,
        scope: SCOPES, resource: RESOURCE, state: transaction.state, nonce: transaction.nonce,
        code_challenge_method: "S256", code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url") }).toString();
      pending = { ...transaction, authorizationUrl: url.href };
      return { url: `${callbackOrigin}/auth/login?state=${transaction.state}` };
    },

    login(parameters) {
      if (!pending || pending.expiresAt <= now() || parameters.get("state") !== pending.state) fail("invalid_state");
      return pending.authorizationUrl;
    },

    async callback(parameters) {
      if (!pending || pending.expiresAt <= now() || parameters.getAll("state").length !== 1 ||
          parameters.get("state") !== pending.state) fail("invalid_state");
      const transaction = pending;
      pending = null;
      if (parameters.has("error")) fail("auth_denied");
      const issued = parameters.get("client_id") ?? transaction.registration?.clientId;
      const code = parameters.get("code");
      if (!issued?.startsWith("oaiapp_") || !code || parameters.getAll("code").length !== 1 ||
          parameters.getAll("client_id").length > 1 ||
          (transaction.registration && issued !== transaction.registration.clientId)) fail("invalid_identity");
      const response = await exchange({ grant_type: "authorization_code", client_id: issued, code,
        code_verifier: transaction.verifier, redirect_uri: `${callbackOrigin}/auth/callback` });
      const tokens = tokenSet(response, null, now());
      const claims = await identity(tokens.idToken, issued, transaction.nonce);
      if (transaction.registration && claims.sub !== transaction.registration.subject) fail("invalid_identity");
      const model = await modelFor(tokens);
      await commit({ ...state, registration: { clientId: issued, subject: claims.sub,
        label: typeof claims.email === "string" ? claims.email : claims.sub }, tokens, model }, transaction.generation);
    },

    async status() {
      if (!state.tokens) return { connected: false, account: null, model: null };
      await access();
      return { connected: true, account: state.registration.label, model: state.model };
    },

    access,
    activeRequests,

    async logout() {
      const expected = ++generation;
      pending = null;
      for (const request of activeRequests) request.abort();
      const previous = state;
      state = { ...state, tokens: null, model: null };
      // A new login must not cancel credential erasure already queued by logout.
      await commit(state, expected, true);
      let revoked = previous.tokens === null;
      if (previous.tokens) {
        try {
          const config = await discovery();
          const response = await fetchImpl(config.revocation_endpoint, {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: previous.tokens.refreshToken, token_type_hint: "refresh_token",
              client_id: previous.registration.clientId }), signal: AbortSignal.timeout(10_000), redirect: "error",
          });
          revoked = response.status === 200;
          await response.body?.cancel();
        } catch { revoked = false; }
      }
      return { connected: false, revoked };
    },
  };
}
