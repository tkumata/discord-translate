# Discord ローカル翻訳 API

Apple Silicon Mac 上の `mlx_lm.server` と Qwen の MLX 4bit モデルを使い、Discord の本文を外部 API へ送らずに日本語訳する構成です。API は `127.0.0.1` のみで待ち受け、Chrome Extensionは `extension/` に含まれます。独自サーバ、サーバ側cache、launchdは追加していません。

現在の製品設計は、ON中の各Discordメッセージに`翻訳`buttonを表示し、押したメッセージだけを翻訳する方式です。手動翻訳UI、Phase 5.6のbridge既定配線復旧と120秒timeout、Node自動検証は実装済みで、是正後の実Chromeでも翻訳動作を確認して完了としました。

## 前提

実装時に確認できた環境は次のとおりです。

- Apple M4 / 24 GB
- macOS 26.6.2 / `arm64`
- Python 3.14.7（native arm64）
- 空きディスク約 309 GiB
- 初期モデル: `mlx-community/Qwen3-8B-4bit`
- 依存: `mlx-lm==0.31.3` / `mlx==0.32.0` / `transformers==5.15.0`

Qwen3-8B-4bit は翻訳の常駐速度とメモリのバランスを優先した初期候補です。Qwen3.5 は初期構成に含めていません。モデルを変更する場合は、同じ固定テストケースで品質、初回/通常 latency、RSS、連続要求後の安定性を比較してください。

## 環境構築

リポジトリのルートで実行します。

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/mlx_lm.server --help
```

導入後の確認（本文を送信しません）。

```bash
./.venv/bin/python - <<'PY'
import importlib.metadata
import mlx.core as mx

print("mlx-lm", importlib.metadata.version("mlx-lm"))
print("mlx", importlib.metadata.version("mlx"))
print("metal", mx.metal.is_available())
PY
```

`.venv` への導入と `pip check` は成功しています。`mlx_lm.server --help` も成功し、使用する `--host`、`--port`、`--allowed-origins`、`--chat-template-args`、`--decode-concurrency`、`--prompt-concurrency`、`--log-level` を確認済みです。

## モデルの初回取得

初回だけ Hub への接続を許可してモデルをキャッシュします。本文ではなく固定の短いテスト文だけを使います。

```bash
export MODEL=mlx-community/Qwen3-8B-4bit
HF_HUB_OFFLINE=0 HF_HUB_DISABLE_TELEMETRY=1 \
  ./.venv/bin/mlx_lm.generate \
  --model "$MODEL" \
  --prompt 'Translate into Japanese: The build passed.' \
  --max-tokens 8
```

モデル取得が完了したら、通常の起動では `start-server.sh` が `HF_HUB_OFFLINE=1` を設定します。キャッシュ済みモデルがない状態で起動すると失敗します。

`Qwen3-8B-4bit` の download と単体 generate は成功しました。単体 generate の実測は prompt 11.294 tok/s、generation 17.776 tok/s、peak 4.707 GB です。単体 generate の既定値では thinking 出力が発生したため、翻訳用途では server 起動時と request の `enable_thinking=false` を必須にしています。

## 起動と停止

Chrome Extension の実 ID（`chrome://extensions` の「拡張機能 ID」）を設定します。Chrome の ID は `a`〜`p` の 32 文字です。`*`、`https://discord.com`、任意の origin は設定できません。

```bash
export MODEL=mlx-community/Qwen3-8B-4bit
export PORT=8080
export CORS_ORIGIN=chrome-extension://abcdefghijklmnopabcdefghijklmnop
./scripts/start-server.sh
```

スクリプトは常に `--host 127.0.0.1`、`--decode-concurrency 1`、`--prompt-concurrency 1`、`--log-level CRITICAL`、`enable_thinking=false` で `exec mlx_lm.server` を実行します。`MODEL` は空値、`-` 始まり、制御 whitespace を拒否し、`PORT` は 1〜65535、`CORS_ORIGIN` は Chrome Extension origin の形式だけを受け付けます。

停止はフォアグラウンドで `Ctrl-C` です。PID ファイルや supervisor は作りません。

別のモデルを使う場合は、先に `MODEL` を変更して初回取得し、キャッシュ済みであることを確認してから起動します。初期スクリプトは常に offline なので、モデル取得のために起動スクリプトの offline 設定を外さないでください。

`start-server.sh` による offline 起動、再起動後の `/health` HTTP 200、`Ctrl-C` による停止を実機で確認済みです。

## API

エンドポイントは `POST http://127.0.0.1:8080/v1/chat/completions` です。クライアントの `model` は省略し、起動時の `MODEL` を正本にします。非 streaming の応答から `choices[0].message.content` だけを翻訳文として扱います。

```bash
curl --fail-with-body \
  -H 'Content-Type: application/json' \
  -H "Origin: ${CORS_ORIGIN}" \
  http://127.0.0.1:${PORT}/v1/chat/completions \
  --data-binary @- <<'JSON'
{
  "messages": [
    {
      "role": "system",
      "content": "You are a translation engine. Translate the user's message into natural Japanese. Output only the translation. Preserve Markdown, URLs, usernames, channel names, emoji, code, inline code, product names, API names, library names, and identifiers where appropriate. Do not explain or repeat the source text."
    },
    {"role": "user", "content": "Looks like they fixed the regression."}
  ],
  "chat_template_kwargs": {"enable_thinking": false},
  "temperature": 0.7,
  "top_p": 0.8,
  "top_k": 20,
  "min_p": 0,
  "max_tokens": 1024,
  "stream": false
}
JSON
```

起動確認には既存の endpoint を使います。

```bash
curl --fail http://127.0.0.1:${PORT}/health
curl --fail http://127.0.0.1:${PORT}/v1/models
```

`/health` の `{"status":"ok"}` は HTTP サーバの応答確認です。モデル ready の判定には `/v1/chat/completions` の実要求を使います。`reasoning`、`<think>`、空の content、`finish_reason=length`、非 2xx、schema 不正は成功扱いにしません。

## Chrome Extensionの導入と使い方

1. Chromeで `chrome://extensions` を開き、Developer modeを有効にします。
2. `Load unpacked` を選び、このリポジトリの `extension/` ディレクトリを指定します。
3. 表示された拡張機能ID（`a`〜`p` の32文字）をコピーします。
4. `CORS_ORIGIN`へ `chrome-extension://<拡張機能ID>` を設定してサーバを起動します。

```bash
export CORS_ORIGIN="chrome-extension://abcdefghijklmnopabcdefghijklmnop"
./scripts/start-server.sh
```

Extensionは次の経路で通信します。

```text
content script --chrome.runtime.sendMessage--> service worker --validated Port--> hidden bridge.html --fetch--> 127.0.0.1:8080
```

content scriptとservice workerからlocalhostを直接fetchせず、service workerは受信順の有限queue（concurrency 1、unique job最大64、queue待機120秒、job監督120秒）と成功結果だけのmemory LRU cache（最大256件、30分）を所有します。HTTPだけは同じDiscord tab内のhidden `bridge.html`へ委譲し、bridgeは固定URLへのPOSTを120秒の有限timeoutで実行します。queue/cache/本文/訳文はstorageへ保存しません。Phase 5.6で既定`defaultTranslator`を検証済みbridge registryへ再接続し、両timeoutを120秒へ揃えています。

```json
{
  "host_permissions": ["http://127.0.0.1:8080/*"]
}
```

service workerは上記API契約（`stream:false`、`model`省略、`chat_template_kwargs.enable_thinking=false`）のpayloadを構築し、HTTP error、timeout、空応答、truncation、schema/thinking不正を最終検証して固定error codeへ変換します。bridgeは`http://127.0.0.1:8080/v1/chat/completions`、`POST`、`Content-Type: application/json`、120秒timeoutを固定し、URL・method・header・payloadを外部入力から受けない設計です。content scriptは各メッセージに`翻訳`buttonを1つ表示し、押下後は`翻訳中…`として連打を抑止します。成功時は原文直下に `lang="ja"` の訳文、失敗時は固定error codeと `再試行` buttonを表示します。

Phase 5.6実装前の実Chrome診断では、一部messageは成功し、一部は25秒で`request_timeout`となり、server側では後続の応答write時に`BrokenPipeError`が発生しました。server停止ではなく、ホスト側`/health`はHTTP 200、0.001118秒でした。当時は`defaultTranslator`のbridge request配線が無効となり、service worker direct fetchが既定経路でした。Phase 5.6でbridge配線を復旧し、bridge fetchとservice worker job監督を120秒へ揃えました。queue待機120秒、queue/cache/API payload/permission/server/UIは変更していません。是正後の実Chromeで翻訳動作を確認し、本変更を完了としました。

Popupの `有効` をONにすると、まずcheckboxが無効化され、popup documentから固定 `GET http://127.0.0.1:8080/health` を5秒timeoutで実行します。ChromeがLocal Network Access許可を求めた場合は許可してください。HTTP 200かつ厳密な `{"status":"ok"}` の場合だけ `enabled=true` を保存し、bridgeとmessage監視を開始して現在表示中・新規messageへ`翻訳`buttonを表示します。ONにしただけでは翻訳POSTを行いません。初期値はOFFです。ON→OFFはhealth確認なしで即時保存し、button、訳文、loading、errorを除去して新規要求を止めます。翻訳POSTは`翻訳`または`再試行`押下から届いた要求のcache miss時だけ発生します。popup health GET、DOM検出、button/bridge生成、cache hitは翻訳POSTではありません。本文と訳文は `chrome.storage.local`、console、server logへ保存しません。

health失敗時はOFFのまま、本文を含まない日本語状態と次の固定codeをpopupへ表示します: `lna_denied`、`health_timeout`、`health_network_error`、`health_http_error`、`health_invalid_response`。Discord側の翻訳失敗は `翻訳できませんでした（<固定error code>）` と表示し、bridge未接続・切断は `bridge_unavailable`、SHA-256失敗は `hash_error`、翻訳fetchのLNA拒否は `lna_denied`、未知の値やその他の送信例外は `network_error` に正規化します。

Manifest権限は `storage` と `http://127.0.0.1:8080/*` のhost permissionだけです。`web_accessible_resources`は`bridge.html`を`https://discord.com/*`へ公開する1組だけで、`bridge.js`は公開しません。`tabs`、`activeTab`、`scripting`、`<all_urls>`、Discord API権限は宣言していません。実ChromeのLocal Network Access許可UIが表示された場合はlocalhost通信を許可してください。Extension IDと `CORS_ORIGIN` が一致しない場合、またはserver停止中は失敗表示になります。

## 検証と benchmark

サーバ起動中に、標準ライブラリだけの検証を実行します。固定の非機密ケースで API/schema、thinking 無効、URL/Markdown/code/username/channel/emoji の保持、日本語入力、prompt 風入力、20 件の直列要求、latency を確認します。本文は表示・保存しません。Extensionの純粋ロジックはNode標準testで検証します。

```bash
./.venv/bin/python scripts/verify.py --origin "$CORS_ORIGIN" --count 20
```

サーバ単体baselineでは `/health`、CORS、6ケース、20件直列の計26リクエストが成功し、平均latencyは1.843 s、直列最大latencyは2.113 s、RSSは4,831,392 KBでした。今回のGoogle Chrome headless temporary profileではunpacked load、service worker target `chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/service_worker.js`、popup page生成、実ID `chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf` の `/health` とCORS preflightが成功しました。Phase 5.6対象test 22件と、手動翻訳UIを含むExtension全体のNode test 35件も成功しています。Phase 5.6診断では、host serverへ180秒timeoutで固定7ケースを実行し、healthと6ケースは0.786〜2.131秒で成功、dailyは日本語条件で不合格でした。コマンド全体は25秒を超えて継続し、同じdaily短文の単独再実行はHTTP 200、1.371552秒でした。本文・応答は表示・保存していません。Phase 5.6実装後の実Chromeでも翻訳動作を確認済みです。

サーバ不要の純粋ロジック検査は次で実行できます。URL、Extension origin、count の入力境界と response schema、thinking、truncation を確認し、ネットワークへ接続しません。

```bash
./.venv/bin/python scripts/verify.py --self-check
node --check extension/content-script.js
node --check extension/service-worker.js
node --check extension/popup.js
node --test extension/tests/*.test.js
node -e "JSON.parse(require('node:fs').readFileSync('extension/manifest.json', 'utf8'))"
git diff --check
```

`--origin` を省略すると CORS preflight の検査だけを省略します。`--base-url` は誤送信防止のため `http://127.0.0.1` 以外を拒否します。

手動 benchmark では、モデル load 時刻、最初の completion、warm completion、応答の `usage`、RSS peak、20〜100 件直列後の RSS を同一条件で記録します。

```bash
time curl --fail -sS http://127.0.0.1:${PORT}/v1/chat/completions -H 'Content-Type: application/json' --data-binary @request.json >/dev/null
pgrep -f 'mlx_lm.server' | xargs -n1 ps -o pid=,rss=,command= -p
```

翻訳品質は日常英語、技術 Discord、Markdown/URL、code block、slang、複数文、日本語入力を目視判定します。今回のMarkdown/URL固定条件は未合格です。build/import成功やheadless unpacked loadだけで品質、service worker fetch、外部通信なし、実機のメモリ安全性を証明したことにはしません。

## ログと通信

`--log-level CRITICAL` により、通常の request body、prompt、response を server log に出さない設定です。`verify.py` も request/response body を出力・保存しません。CORS はブラウザの制御であり、同じ Mac の別プロセスからの接続を認証するものではありません。

モデルをキャッシュした後に起動プロセスの接続を `lsof -nP -p <PID> -i` で確認し、loopback 以外の接続がないことを確認します。今回の確認では外部 TCP 接続はありませんでした。`--log-level CRITICAL` でも HTTP access log は stderr に出ますが、request/response 本文は出力されませんでした。

## トラブルシューティング

- `.../.venv/bin/mlx_lm.server is missing`: `.venv` 作成と `pip install -r requirements.txt` を実行します。
- `CORS_ORIGIN ...`: `chrome://extensions` の 32 文字の ID を `chrome-extension://` に続けて設定します。`*` は禁止です。
- 起動時にモデル取得へ進まない: 初回取得コマンドを offline なしで一度実行し、同じ `MODEL` を指定します。
- `/health` は成功するが翻訳が失敗する: readiness は completion で確認し、server の標準エラーと `verify.py` の HTTP/schema 結果を確認します。本文をログへ追加しないでください。
- `finish_reason=length`: 入力に対して既定の `max_tokens=1024` でも不足しています。入力長を見直し、1024でも再発する場合は別方式を検討します。
- 連続要求で混線または hang がある: Extension と server の concurrency を 1 のまま再現確認し、queue 2 や別モデルへ変更しません。
- `翻訳`buttonまたは訳文が表示されない: `chrome://extensions`でExtensionをreloadし、Discord tabをreloadして、popupをOFF→ONにした後、対象messageの`翻訳`を押します。serverの `CORS_ORIGIN` が実IDと一致し、`/health` とcompletionが成功することも確認します。
- popupで有効化できない: 表示された `lna_denied`、`health_timeout`、`health_network_error`、`health_http_error`、`health_invalid_response` を確認します。serverを起動し、popupを開いたままOFF→ONを再試行してください。本文はpopupへ送信されません。
- `翻訳できませんでした（<固定error code>）`: server停止、CORS/LNA、queue上限/期限、HTTP/schema/thinking/truncation、SHA-256の固定errorです。原文は残るため、server復旧後に `再試行` を押します。未知の送信例外は `network_error` です。
- `request_timeout`とserverの`BrokenPipeError`: Phase 5.6実装前の25秒timeoutとservice worker direct fetchで観測した問題です。既定bridge配線を復旧してtimeoutを120秒へ揃え、実Chromeの翻訳動作を確認済みです。

## 未実行・対象外

静的検証、依存導入、model download、offline起動、localhost API、headless unpacked load、service worker target/popup page生成、実IDのCORS preflight、Phase 5.6対象test 22件、手動翻訳UIを含むExtension全体のNode test 35件、実Chromeの手動翻訳・timeout境界・異常系、直列要求、RSS、停止、外部TCP接続なしは確認済みです。以下は今回の手動翻訳・bridge是正とは別の対象です。

- 認証済みDiscordでの候補DOM selector、message編集、virtual scroll、channel遷移の確認
- 通常GUIでのpopup/service worker lifecycle確認（headless終了時に`content_verify_job`のpopup.html reason:1 logを1件観測）
- Markdown/URL固定条件（`**the patch**`）の再確認
- LAN 上の別端末から接続できないことの確認
- 100 件短文後のメモリ増加確認

launchd（`~/Library/LaunchAgents`）は基本機能の実機検証後に別承認で追加します。
