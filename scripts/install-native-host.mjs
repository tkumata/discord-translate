import { chmod, mkdir, writeFile } from "node:fs/promises";
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
    await mkdir(directory, { recursive: true });
    for (const provider of ["chatgpt", "local"]) {
      const name = `com.discord_translate.${provider}`;
      const launcher = join(directory, `${name}.sh`);
      const host = fileURLToPath(new URL(`${provider}-native-host.mjs`, import.meta.url));
      await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(host)} "$@"\n`, { mode: 0o700 });
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
