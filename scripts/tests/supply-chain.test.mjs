import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("extension and helper stay free of external npm dependencies and remote extension execution", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../extension/package.json", import.meta.url), "utf8"));
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies"]) {
    assert.equal(Object.keys(pkg[key] ?? {}).length, 0, key);
  }
  assert.equal(pkg.type, "module");
  const manifest = JSON.parse(await readFile(new URL("../../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'; connect-src http://127.0.0.1:8080 http://127.0.0.1:8766;");
  assert.equal(manifest.content_security_policy.sandbox, undefined);
  assert.equal(manifest.sandbox, undefined);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:8080/*", "http://127.0.0.1:8766/*"]);
});
