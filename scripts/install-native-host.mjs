import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionId = process.argv[2];
if (process.platform !== "darwin" || process.argv.length !== 3 || !/^[a-p]{32}$/.test(extensionId)) {
  console.error("Usage (macOS): node scripts/install-native-host.mjs <Chrome extension ID>");
  process.exitCode = 1;
} else {
  const directory = join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    const nvmRoot = process.execPath.match(/^(.*)\/versions\/node\/v\d+\.\d+\.\d+\/bin\/node$/)?.[1];
    if (nvmRoot) await access(join(nvmRoot, "nvm.sh"));
    const resolveNode = nvmRoot ? `node=''
version=''
for candidate in ${quote(nvmRoot)}/versions/node/v*/bin/node; do
  [ -x "$candidate" ] || continue
  if candidate_version=$("$candidate" -p 'process.release.lts && parseInt(process.versions.node, 10) >= 24 ? process.versions.node : ""' </dev/null); then
    [ -n "$candidate_version" ] || continue
    latest=$(printf '%s\\n' "$version" "$candidate_version" |
      /usr/bin/sort -t. -k1,1n -k2,2n -k3,3n | /usr/bin/tail -n 1)
    if [ "$latest" = "$candidate_version" ]; then
      node="$candidate"
      version="$candidate_version"
    fi
  else
    printf 'native_host_node_probe_failed: %s\\n' "$candidate" >&2
  fi
done
if [ -z "$node" ]; then
  printf 'native_host_node_unavailable: nvm に Node.js 24 以上の LTS がありません。\\n' >&2
  exit 1
fi
` : `node=${quote(process.execPath)}\n`;
    await mkdir(directory, { recursive: true });
    for (const provider of ["chatgpt", "local"]) {
      const name = `com.discord_translate.${provider}`;
      const launcher = join(directory, `${name}.sh`);
      const host = fileURLToPath(new URL(`${provider}-native-host.mjs`, import.meta.url));
      await writeFile(launcher, `#!/bin/sh\n${resolveNode}exec "$node" ${quote(host)} "$@"\n`, { mode: 0o700 });
      await chmod(launcher, 0o700);
      await writeFile(join(directory, `${name}.json`), `${JSON.stringify({
        name, description: `Discord Translator ${provider} server`, path: launcher, type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      }, null, 2)}\n`, { mode: 0o600 });
    }
    console.log("両翻訳先の Native Messaging を登録しました。手動起動したサーバを停止し、Chrome 拡張機能を再読み込みしてください。");
  } catch {
    console.error("native_host_install_failed: Chrome の NativeMessagingHosts 保存先を確認してください。");
    process.exitCode = 1;
  }
}
