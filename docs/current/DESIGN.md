# 設計書

- Status: Current
- Last reviewed: 2026-08-19

## 1. 設計目的

単一ユーザーが選んだ Discord メッセージだけを翻訳する責務を配置し、Discord 本文を Mac 外へ送らず、MLX-LM の公式 server を再実装しない。外部動作は [仕様書](SPECIFICATIONS.md)、長期判断は [ADR索引](../adr/README.md) を正本とする。

## 2. システム構成と実装状態

```text
[実装済み・Node test合格 / 実Chrome検証済み] Discord Web / content script
    selector候補 / 各message の翻訳 button / 原文直下 UI / stale結果破棄
                │ chrome.runtime.sendMessage
                ▼
[実装済み・実Chrome health成功] Extension popup
    OFF→ON 時だけ GET /health / LNA prompt / enabled 確定
                │ 許可済み Extension origin
                ▼
[Phase 5.6 完了 / 実 Chrome 検証済み] Extension service worker
     sender/input / queue=1, max=64 / payload / response / cache=256, 30min
                │ validated runtime.Port / job
                ▼
[Phase 5.6 完了 / 実 Chrome 検証済み] hidden Extension document bridge
     fixed URL / POST / fetch=120s / fixed result envelope
                │ POST http://127.0.0.1:8080/v1/chat/completions
                ▼
[実装済み] scripts/start-server.sh
                │ exec / loopback / offline / CORS
                ▼
[実装済み] mlx_lm.server 0.31.3
                │ local model load
                ▼
[cache済み・検証済み] mlx-community/Qwen3-8B-4bit

[未実装] launchd LaunchAgent
```

Chrome Extensionのcontent script/service worker/bridge、Node自動検証、実ID CORS preflight、実Chromeのpopup health成功を確認した。content scriptはDOM検出時にはbuttonだけを作り、button押下時だけ要求する。Phase 5.6実装前の実Chromeでは一部messageの訳文表示と一部の`request_timeout`、server側`BrokenPipeError`を観測し、`defaultTranslator`のbridge `requestImpl`が無効化されて既定経路がservice worker direct fetchとなっていた。Phase 5.6でbridge配線を復旧し、両timeoutを120秒へ揃え、対象test 22件とExtension全体35件が合格した。是正後の実Chromeで翻訳、timeout境界、異常系を確認し、Phase 5.6を完了した。

## 3. 責務分割

| コンポーネント | 所有する責務 | 所有しない責務 | 状態 |
| ------------ | ---------- | -------------| --- |
| Discord content script | 対象メッセージ検出、各メッセージの手動翻訳 UI、押下・連打抑止・stale 結果破棄、service worker への依頼、ON 中の bridge iframe 1個の lifecycle | HTTP、payload、Port job、model | 実装・Node test・実 Chrome 検証済み |
| Extension service worker | sender/input/bridge Port 検証、SHA-256、固定 payload、FIFO queue、120秒 job 監督、HTTP status・最終応答検証、`invalid_response` 診断、重複排除、memory cache、結果返却 | Discord DOM、実 HTTP fetch、推論、本文永続化 | Phase 5.6 完了。Node test 合格。実 Chrome 診断確認待ち |
| Extension document bridge | 検証済み Port、固定 localhost URL への 120秒 POST、固定 result envelope、HTTP 200 JSON parse失敗時の`invalid_response`診断 | page message、任意 URL/payload、queue/cache、最終 API schema、storage | Node test 合格。実 Chrome 診断確認待ち |
| Extension popup | 全 Discord タブ共通の`enabled` 状態遷移、LNA prompt を trigger する固定 `/health` GET、5秒 timeout、厳密 health 検証、本文なし状態 code 表示 | Discord DOM、翻訳本文、chat completion、queue/cache | 実装済み・Node test 合格・実 Chrome health 成功 |
| `scripts/start-server.sh` | 起動入力検証、loopback/CORS/offline/concurrency/log 設定、server exec | HTTP API 再実装、request 内容検証、cache | 実装済み |
| `mlx_lm.server` | HTTP endpoint、モデルロード、生成処理 | Discord UI、製品固有 queue/cache | 依存として利用中 |
| Qwen MLX model | 翻訳文生成 | 入力経路、権限、ログ方針 | Qwen3-8B-4bit を 検証済み |
| `scripts/verify.py` | 固定非機密ケースで server 契約・CORS・直列性を検証 | 実 Chrome UI、LAN 別端末、100件 stress | 実装済み |
| launchd LaunchAgent | login 起動、process lifecycle | 翻訳仕様、Extension UI | 未実装・後続フェーズ |

## 4. 依存方向

- content script は Chrome messaging と bridge document URL だけに依存し、HTTP 詳細へ依存しない。
- popup は固定 health 契約だけへ依存し、本文・訳文・chat completion 契約へ依存しない。
- service worker は localhost API 契約へ依存し、HTTP 送信を bridge Port 境界へ委譲する。
- bridge は service worker の固定 job 契約と localhost API だけへ依存し、Discord DOM や page message へ依存しない。
- 起動 script は `mlx_lm.server`  CLI へ依存するが、MLX-LM 内部実装を複製しない。
- 検証 script は標準ライブラリだけを使い、server 実装から独立して外部契約を検査する。
- launchd は起動 script を呼び、server 引数を別の正本として複製しない。

この方向により、Discord DOM 変更、Chrome 通信、MLX server 更新、OS lifecycle を別々に変更できる。

## 5. データフロー

### 5.1 翻訳成功

1. `enabled=true` の content script が候補 selector から message container、content、trim 済み本文を取得し、各メッセージへ`翻訳` button を1つ表示する。この検出・表示では要求を送らない。
2. 利用者が `翻訳` または `再試行` を押すと、content script が `翻訳中…` へ遷移して重複押下を抑止し、`type`、`messageId`、`text` だけを service worker へ送る。
3. service worker が sender と入力を検証し、本文の SHA-256 key を求める。
4. 同じ key の running/queued Promise または有効な cache があれば共有し、miss なら FIFO queue へ入れる。
5. queue の先頭 1 件だけを、依頼元 tab ID に対応する検証済み bridge へ送る。
6. bridge が固定 localhost API へ 120 秒 timeout で POST し、固定 envelope を返す。
7. service worker が job ID、HTTP、schema、thinking、truncation を最終検証する。
8. content script が container 接続、content node、本文不変を再検証する。
9. stale でなければ原文を残し、content 直後へ「日本語訳」ラベル付きの訳文ブロックを表示する。

手順 1〜9 は実装・Node test 済みである。Phase 5.6 で既定 `defaultTranslator` を bridge `requestImpl` へ復旧し、bridge fetch と service worker job 監督を 120 秒へ揃えた。実 Chrome で翻訳、timeout 境界、異常系を検証済みである。

### 5.2 有効化と LNA bootstrap

1. popup で OFF→ON を操作すると、checkbox を disabled にして `接続確認中` を表示する。
2. popup document が固定 `http://127.0.0.1:8080/health` へ 5 秒 timeout の GET を行い、Chrome の LNA prompt を trigger する。
3. LNA 許可、HTTP 200、追加 field のない `{"status":"ok"}` をすべて満たす場合だけ `enabled=true` を保存する。
4. 拒否、timeout、network、HTTP、schema 失敗では OFF を維持し、日本語状態と固定 code だけを表示する。
5. ON→OFF は health なしで即時 `enabled=false` を保存する。

popup の health GET は LNA 許可取得に必要な例外であり、本文・訳文を受け取らない。ON では bridge と observer を開始するが翻訳 POST は行わない。翻訳 POST、queue/cache、response 検証は既存の service worker/bridge 境界に留める。

### 5.3 失敗

- SHA-256失敗、local network拒否、timeout、その他network、HTTP error、JSON/schema不正、空content、thinking、truncationは固定codeへ正規化する。
- jobは別メッセージへ再割り当てしない。
- content scriptは原文を削除せず、service workerの既存固定error codeと再試行可能な状態を表示する。
- 無限retryしない。利用者の再試行buttonだけが新しいjobを作る。
- API応答の最終検証が`invalid_response`になったときだけservice workerが、bridgeのHTTP 200 JSON parseが失敗したときだけbridgeが、固定ラベルと4項目のmetadataをDevTools consoleへ出す。成功時と他のerror codeでは出さず、本文・訳文・payload・response・URL・ID・`error.message`・例外objectを渡さない。
- SHA-256失敗は`hash_error`、fetchの`NotAllowedError`/`SecurityError`は`lna_denied`、fetch timeoutは`request_timeout`、その他fetch拒否と未知値は`network_error`とする。queue上限、queue待機、service worker終了も固定error codeへ正規化し、本文、URL、`error.message`を含めない。Phase 5.3後の実Chromeは`network_error`でPOST未到達。Phase 5.4ではbridge未接続・切断を`bridge_unavailable`へ分離する。
- process再起動後は利用者の再試行または新規messageで処理を再開する。
- Phase 5.6実装前は25秒でclient側だけがtimeoutしserver生成が継続すると、serverの応答write時に接続先がなく`BrokenPipeError`となった。bridge fetchとservice worker job監督を120秒へ揃え、観測済みの25秒超tailを有限上限内で完了させる。server-side cancellationは追加しない。実Chromeで境界条件と`BrokenPipeError`解消を検証済みである。

### 5.4 POST の発生条件

- `翻訳`または`再試行`押下から届いた正規要求だけがservice workerのqueue/cacheへ進む。
- cache missで実行対象になったjobだけをbridgeが固定APIへPOSTする。
- DOM検出、button生成、bridge生成、popup health GET、cache hitは翻訳POSTではない。

## 6. 状態管理

### 6.1 Server lifecycle

```text
stopped -> starting -> http-ready -> model-ready
   ^          |             |            |
   +----------+-------------+------------+
              error / Ctrl-C / process exit
```

`/health` は `http-ready` の証拠であり、chat completion成功だけを `model-ready` とする。プロセス状態の所有者はforeground shell、後続フェーズではlaunchdである。

### 6.2 Extension queue

```text
received -> cached-result
    |
    +-> duplicate-of-existing
    |
    +-> queued -> running -> succeeded -> memory-cache
          |          |
          |          +-> failed
          +-> queue-timeout
```

queueとcacheの所有者はservice workerに一意化する。unique jobはrunningを含め最大64、queue待機120秒、bridge fetchとservice worker job監督は120秒、concurrency 1とする。最大待機+実行は240秒でChromeの単一処理5分未満に収める。jobは最初の正規requestのtab IDを保持し、同一keyは同じPromiseを共有する。cache keyはtrim済み本文のSHA-256、成功訳文を最大256件・30分のmemory LRUへ保存する。service workerまたはbridge終了時はin-flightを復旧保存しない。

`chrome.runtime.onMessage`と`chrome.runtime.onInstalled` listenerはmodule top-levelで同期登録する。event listener登録を非同期初期化の完了後へ遅らせない。global stateはworker生存中の最適化に限り、再生成されても設定以外の永続状態を要求しない。

### 6.3 UI 設定

`enabled`だけを`chrome.storage.local`のsource of truthとする。install時の既定値はfalseで、update時に既存値を上書きしない。OFF→checking→ON/OFFの判断はpopupのpure export可能な状態遷移へ分離し、fetchとStorage APIは境界として注入可能にする。popup、content scriptはStorage API経由で読み、content scriptは`chrome.storage.onChanged`でON/OFFを反映する。本文、訳文、job、cacheはstorageへ保存しない。

メッセージUIの最小状態は`翻訳`、`翻訳中…`、`訳文`、`固定error code + 再試行`である。状態所有者はcontent scriptの対象content nodeごとのrecordとし、`翻訳中…`ではbuttonをdisabledにする。本文変更またはDOM差し替えで旧recordを表示対象から外し、ON中の新本文には新しい`翻訳`を1つ作る。OFFではobserver、bridge、すべての挿入UIとrecordを破棄し、新規要求を作らない。

訳文UIは既存の`data-discord-translate="translation"`と`lang="ja"`を持つ親要素を維持し、その内部に可視の`日本語訳`ラベルと訳文本体を配置する。ラベルと本文は`textContent`で設定し、HTMLとして解釈しない。CSSで上余白8px、左線、薄い背景と内側余白を付け、通常の本文色と改行を維持する。2026-08-27の表示改善について、検証結果は[変更記録](../plans/completed/2026-08-27-translation-boundary.md)を参照する。

## 7. 外部境界

### 7.1 Chrome 境界

content scriptとservice workerからlocalhostへ直接fetchしない。popupはOFF→ON時の固定health GETだけを行う。service workerは正規content senderとbridge Portを別々に検証し、同じtab IDの場合だけ固定jobを渡す。bridgeはpage messageを受けず、固定localhost POSTだけを実行する。Manifestは`bridge.html`だけをDiscord origin向けweb accessible resourceへ追加し、permissionは増やさない。Phase 5.6でservice worker direct fetchを既定経路から除き、検証済みbridge registryへ復旧した。詳細判断は[ADR-005](../adr/005-extension-document-translation-bridge.md)を参照する。

### 7.2 Network 境界

listenerはIPv4 loopbackのみである。CORSは実Extension originに限定するが、同一Mac上のローカルprocessに対する認証ではない。LAN公開やmulti-user化は設計対象外である。

### 7.3 Model/Hub 境界

初回model downloadだけHub接続を許し、通常運用はcache済みmodelとoffline modeを使う。翻訳本文をmodel download処理へ渡さない。model名は環境変数で変更可能だが、未検証modelを採用済みとは扱わない。

### 7.4 OS 境界

現行はforeground processである。launchd追加時も`start-server.sh`を唯一のserver起動入口とし、loopback/offline引数をplistへ重複させない。

## 8. データと永続化

- Discord本文、system prompt、responseはファイル・DB・通常ログへ永続化しない。`invalid_response`時の4項目metadataだけはDevTools consoleへ一時出力するが、storageや外部通信へ保存・送信しない。
- Qwen model filesとPython packagesだけをローカルcache/`.venv`へ保存する。
- Extension cacheは実装済み・Node test合格である。trim済み本文のSHA-256をkeyに成功訳文だけをmemoryへ最大256件・30分保持し、service worker終了時に破棄する。
- Extension storageへ保存する製品状態はbooleanの`enabled`だけである。
- benchmark結果を保存する場合は固定の非機密入力だけを使い、本文を含めない。

## 9. Extension実装単位

新しいruntime依存・build stepは追加せず、Chrome APIと標準Web APIだけを使う。

| ファイル | 責務 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extension/manifest.json` | MV3、Discord content script、module service worker、popup、`storage`、loopback host permission |
| `extension/service-worker.js` | sender/input/Port 検証、固定 payload、FIFO queue、重複 Promise、memory LRU、bridge registryを使う既定job 配線、120秒 job 監督、HTTP/response 最終検証 |
| `extension/content-script.js` | DOM 検出、各 message の翻訳 button、押下時だけの依頼、連打抑止、bridge iframe 1個の ON/OFF lifecycle、stale 結果破棄、手動再試行 |
| `extension/bridge.html` | 非表示 Extension document と外部入力を持たない静的 script 入口 |
| `extension/bridge.js` | 固定 Port job の検証、固定 localhost POST、120秒 timeout、固定result envelope |
| `extension/styles.css` | 翻訳 button、loading、訳文、error、再試行 button の最小表示。Discord class へ依存しない |
| `extension/popup.html` | `enabled` checkbox と本文なし接続状態の静的markup |
| `extension/popup.js` | pure export 可能な有効化状態遷移、固定health GET、5秒 timeout、厳密 schema、`chrome.storage.local`同期 |
| `extension/popup.css` | disabled checkbox と状態 code の最小 layout |
| `extension/package.json` | Node に ES module として test 対象を解釈させる`{"type":"module","private":true}` だけ。依存なし |
| `extension/tests/service-worker.test.js` | Node 標準`node:test` による既定 bridge 配線、global fetch 不使用、120秒 timeout、sender URL 境界、input、payload、SHA-256/error 分類、response、FIFO、上限、重複、cache の回帰検査 |
| `extension/tests/popup.test.js` | Node 標準`node:test`によるhealth成功、拒否、timeout、network、HTTP、schema、OFF 遷移の回帰検査 |
| `extension/tests/bridge.test.js` | 固定 URL/payload、120秒timeout、network、HTTP/JSON envelope、任意入力拒否の回帰検査 |
| `extension/tests/content-script.test.js` | scan だけでは要求なし、各message 1 button、クリック1回1要求、連打抑止、成功/失敗/再試行、OFF、本文変更・DOM差し替え時のstale破棄をNode標準`node:test`で検証 |

content scriptのDiscord DOM適合はブラウザDOM実体が必要であり、DOM libraryを追加せずunpacked Chromeの手動結合試験で検証する。実装前preflightは`node --version`、`node -e "require('node:test')"`、`node --check`の可用性確認とする。Nodeがなければ自動test未実行として停止し、依存導入を推測で行わない。

最小検証commandは次とする。

```bash
node --check extension/content-script.js
node --check extension/service-worker.js
node --check extension/popup.js
node --check extension/bridge.js
node --test extension/tests/*.test.js
node -e "JSON.parse(require('node:fs').readFileSync('extension/manifest.json', 'utf8'))"
git diff --check
```

## 10. 実装済みbaseline

- `mlx-lm==0.31.3`、`mlx==0.32.0`、`transformers==5.15.0`
- Apple M4 / 24 GB / macOS 26.6.2 / native arm64 Python 3.14.7
- Qwen3-8B-4bit download・offline起動・thinking抑制
- server baselineでは`/health`、CORS、固定6ケース、20件直列の計26件成功（後続の実ID検証はMarkdown/URL条件未合格）
- 平均1.843秒、直列最大2.113秒、RSS 4,831,392 KB
- `127.0.0.1:8080` listener、確認時の外部TCP接続なし

これらはserver baselineの証拠であり、Chrome E2E、LAN拒否、100件メモリ安定性、launchdの証拠ではない。

## 11. 関連判断

- [ADR-001: 公式mlx_lm.serverを直接利用する](../adr/001-use-official-mlx-lm-server.md)
- [ADR-002: loopbackとofflineをprivacy境界にする](../adr/002-loopback-offline-privacy-boundary.md)
- [ADR-003: service workerがqueueとcacheを所有する](../adr/003-service-worker-owns-queue.md)
- [ADR-004: popupでLNA許可をbootstrapする](../adr/004-popup-lna-bootstrap.md)
- [ADR-005: Extension document bridgeに翻訳HTTP境界を委譲する](../adr/005-extension-document-translation-bridge.md)（Accepted, implemented; Chrome translation verified）
- [ADR-006: メッセージ単位の手動翻訳を採用する](../adr/006-manual-per-message-translation.md)（Accepted, implemented; Chrome verified）

Qwen3.5、queue 2、FastAPI/Flask、launchd詳細は採用判断が完了していないためADRにしていない。
