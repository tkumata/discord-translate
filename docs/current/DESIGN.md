# 設計書

2026-10-02承認の順次表示を実装済み。第12節に詳細を記載する。自動・実モデル検証は成功、実Chromeも2026-10-02のユーザーによるTask 5実機確認で合格した。入力KV cacheの実機確認結果は仕様書SPEC-KV-001を参照する。

- Status: Current
- Last reviewed: 2026-10-05
- Approved addition: 第13節は実装・自動/実モデル検証済み。実Chrome受け入れはユーザ確認で合格。
- Theme addition: 第15節は完了。実機受け入れはユーザの再確認で合格。

## 1. 設計目的

単一ユーザーが選んだ Discord メッセージだけを翻訳する責務を配置し、Discord 本文を Mac 外へ送らず、MLX-LM の公式 server を再実装しない。外部動作は [仕様書](SPECIFICATIONS.md)、長期判断は [ADR索引](../adr/README.md) を正本とする。

## 2. システム構成と実装状態

```text
[実装済み・Node test合格 / 順次表示のTask 5実Chrome確認合格（ユーザー報告）] Discord Web / content script
    selector候補 / 各message の翻訳 button / 原文直下 UI / stale結果破棄
                │ 要求用runtime.Port / progress・result・error
                ▼
[実装済み・実Chrome health成功] Extension popup
    OFF→ON 時だけ GET /health / LNA prompt / enabled 確定
                │ 許可済み Extension origin
                ▼
[実装済み・Node/実モデル検証済み / streamingのTask 5実Chrome確認合格（ユーザー報告）] Extension service worker
     sender/input / queue=1, max=64 / payload / response / cache=256, 30min
                │ validated runtime.Port / job
                ▼
[実装済み・Node/実モデル検証済み / streamingのTask 5実Chrome確認合格（ユーザー報告）] hidden Extension document bridge
     fixed URL / POST / fetch=120s / SSE chunk・end・固定error
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
| Discord content script | 対象メッセージ検出、各メッセージの手動翻訳 UI、押下・連打抑止・stale 結果破棄、service worker への依頼、ON 中の bridge iframe 1個の lifecycle | HTTP、payload、Port job、model | 順次表示は実装・Node test済み、Task 5実Chrome確認合格（ユーザー報告） |
| Extension service worker | sender/input/bridge Port 検証、SHA-256、固定 payload、FIFO queue、120秒 job 監督、HTTP status・stream検証・累積・購読・最終応答検証、`invalid_response` 診断、重複排除、memory cache、受信完成訳の永続保存と検索、結果返却 | Discord DOM、実 HTTP fetch、推論、本文永続化 | 順次表示は実装・Node/実モデル検証済み、Task 5実Chrome確認合格（ユーザー報告） |
| Extension document bridge | 検証済み Port、固定 localhost URL への 120秒 POST、SSE解析・chunk/end通知、HTTP 200 SSE不正時の`invalid_response`診断 | page message、任意 URL/payload、queue/cache、最終 API schema、storage | 順次表示は実装・Node/実モデル検証済み、Task 5実Chrome確認合格（ユーザー報告） |
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
2. 利用者が `翻訳` または `再試行` を押すと、content script が `翻訳中…` へ遷移して重複押下を抑止し、要求用Portで`type`、`messageId`、`text`だけをservice workerへ1回送る。
3. service worker が sender と入力を検証し、翻訳先と本文の SHA-256 key を求める。
4. 同じkeyのrunning/queued jobならPromiseと途中更新を共有し、途中参加へ累積訳文を返す。有効なcacheは完成訳を返し、missならFIFO queueへ入れる。
5. queue の先頭 1 件だけを、依頼元 tab ID に対応する検証済み bridge へ送る。
6. bridgeが固定localhost APIへ120秒timeoutでPOSTし、SSEのJSON chunkと終端を固定envelopeで返す。
7. service workerがjob ID、HTTP、schema、thinking、truncationを検証し、途中累積textを通知する。正常finish、usage、終端を確認した場合だけ成功とcache保存を行う。
8. content scriptが各通知でcontainer接続、content node、本文不変を再検証する。
9. staleでなければ原文を残し、content直後の同じ訳文ブロックを途中更新する。生成中は「日本語訳（翻訳中…）」、最終成功時は「日本語訳」とする。

手順1〜9の順次表示は実装・Node/実モデル検証済み、Task 5実Chrome確認合格（ユーザー報告）である。旧方式については、Phase 5.6 で既定 `defaultTranslator` を bridge `requestImpl` へ復旧し、bridge fetch と service worker job 監督を 120 秒へ揃えた。実 Chrome で翻訳、timeout 境界、異常系を検証済みである。

### 5.2 有効化と LNA bootstrap

1. popup で OFF→ON を操作すると、checkbox を disabled にして `接続確認中` を表示する。
2. popup document が固定 `http://127.0.0.1:8080/health` へ 5 秒 timeout の GET を行い、Chrome の LNA prompt を trigger する。
3. LNA 許可、HTTP 200、追加 field のない `{"status":"ok"}` をすべて満たす場合だけ `enabled=true` を保存する。
4. 拒否、timeout、network、HTTP、schema 失敗では OFF を維持し、日本語状態と固定 code だけを表示する。
5. ON→OFF は health なしで即時 `enabled=false` を保存する。

popup の health GET は LNA 許可取得に必要な例外であり、本文・訳文を受け取らない。ON では bridge と observer を開始するが翻訳 POST は行わない。翻訳 POST、queue/cache、response 検証は既存の service worker/bridge 境界に留める。

### 5.3 失敗

- SHA-256失敗、local network拒否、timeout、その他network、HTTP error、SSE/JSON/schema不正、空content、thinking、truncationは固定codeへ正規化する。
- jobは別メッセージへ再割り当てしない。
- content scriptは原文を残し、部分訳を除去して既存固定error codeと再試行可能な状態を表示する。
- 無限retryしない。利用者の再試行buttonだけが新しいjobを作る。
- stream内容または最終検証が`invalid_response`になったときだけservice workerが、bridgeのHTTP 200 SSE解析が失敗したときだけbridgeが、固定ラベルと4項目のmetadataをDevTools consoleへ出す。成功時と他のerror codeでは出さず、本文・訳文・payload・response・URL・ID・`error.message`・例外objectを渡さない。
- SHA-256失敗は`hash_error`、fetchの`NotAllowedError`/`SecurityError`は`lna_denied`、fetch timeoutは`request_timeout`、その他fetch拒否と未知値は`network_error`とする。queue上限、queue待機、service worker終了も固定error codeへ正規化し、本文、URL、`error.message`を含めない。Phase 5.3後の実Chromeは`network_error`でPOST未到達。Phase 5.4ではbridge未接続・切断を`bridge_unavailable`へ分離する。
- process再起動後は利用者の再試行または新規messageで処理を再開する。
- Phase 5.6実装前は25秒でclient側だけがtimeoutしserver生成が継続すると、serverの応答write時に接続先がなく`BrokenPipeError`となった。bridge fetchとservice worker job監督を120秒へ揃え、観測済みの25秒超tailを有限上限内で完了させる。server-side cancellationは追加しない。実Chromeで境界条件と`BrokenPipeError`解消を検証済みである。

### 5.4 POST の発生条件

- `翻訳`、`再試行`、`英語に翻訳`押下から届いた正規要求だけがservice workerのqueue/cacheへ進む。
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

queueとcacheの所有者はservice workerに一意化する。unique jobはrunningを含め最大64、queue待機120秒、bridge fetchとservice worker job監督は120秒、concurrency 1とする。最大待機+実行は240秒でChromeの単一処理5分未満に収める。jobは最初の正規requestのtab IDを保持し、同一keyは同じPromiseを共有する。cache keyは翻訳先とtrim済み本文をJSON配列へ直列化したSHA-256、成功訳文を最大256件・30分のmemory LRUへ保存する。service workerまたはbridge終了時はin-flightを復旧保存しない。

`chrome.runtime.onConnect`、`chrome.runtime.onMessage`と`chrome.runtime.onInstalled` listenerはmodule top-levelで同期登録する。event listener登録を非同期初期化の完了後へ遅らせない。global stateはworker生存中の最適化に限り、再生成後の受信完成訳はStorage APIから検索する。

### 6.3 UI 設定

UI設定の`enabled`は`chrome.storage.local`をsource of truthとする。install時の既定値はfalseで、update時に既存値を上書きしない。OFF→checking→ON/OFFの判断はpopupのpure export可能な状態遷移へ分離し、fetchとStorage APIは境界として注入可能にする。popup、content scriptはStorage API経由で読み、content scriptは`chrome.storage.onChanged`でON/OFFを反映する。原文、投稿用の訳文、未完了jobはstorageへ保存しない。受信完成訳は第14節に従って保存する。

メッセージUIの最小状態は`翻訳`、`翻訳中…`、`日本語訳（翻訳中…）`、`日本語訳`、`固定error code + 再試行`である。状態所有者はcontent scriptの対象content nodeごとのrecordとし、`翻訳中…`ではbuttonをdisabledにする。本文変更またはDOM差し替えで旧recordを表示対象から外し、ON中の新本文には新しい`翻訳`を1つ作る。OFFではobserver、bridge、すべての挿入UIとrecordを破棄し、新規要求を作らない。

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
- Extension cacheは実装済み・Node test合格である。翻訳先とtrim済み本文をJSON配列へ直列化したSHA-256をkeyに成功訳文だけをmemoryへ最大256件・30分保持し、service worker終了時に破棄する。
- Extension storageへ保存する製品状態は`enabled`と受信完成訳の永続キャッシュである。
- benchmark結果を保存する場合は固定の非機密入力だけを使い、本文を含めない。

## 9. Extension実装単位

新しいruntime依存・build stepは追加せず、Chrome APIと標準Web APIだけを使う。

| ファイル | 責務 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extension/manifest.json` | MV3、Discord content script、module service worker、popup、`storage`、loopback host permission |
| `extension/service-worker.js` | sender/input/Port 検証、固定 payload、FIFO queue、重複 Promise、memory LRU、bridge registryを使う既定job 配線、120秒 job 監督、HTTP/response 最終検証 |
| `extension/received-translation-cache.js` | 受信完成訳の個別キー保存、5日期限、検索、期限切れ削除、Storage API操作の直列化と5秒監督。 |
| `extension/content-script.js` | DOM 検出、各 message の翻訳 button、押下時だけの依頼、連打抑止、bridge iframe 1個の ON/OFF lifecycle、stale 結果破棄、手動再試行 |
| `extension/bridge.html` | 非表示 Extension document と外部入力を持たない静的 script 入口 |
| `extension/bridge.js` | 固定 Port job の検証、固定 localhost POST、120秒 timeout、固定result envelope |
| `extension/styles.css` | 翻訳 button、loading、訳文、error、再試行 button の最小表示。テーマの代替配色だけDiscordのテーマclassを参照する |
| `extension/popup.html` | `enabled` checkbox と本文なし接続状態の静的markup |
| `extension/popup.js` | pure export 可能な有効化状態遷移、固定health GET、5秒 timeout、厳密 schema、`chrome.storage.local`同期 |
| `extension/popup.css` | disabled checkbox と状態 code の最小 layout |
| `extension/package.json` | Node に ES module として test 対象を解釈させる`{"type":"module","private":true}` だけ。依存なし |
| `extension/tests/service-worker.test.js` | Node 標準`node:test` による既定 bridge 配線、global fetch 不使用、120秒 timeout、sender URL 境界、input、payload、SHA-256/error 分類、response、FIFO、上限、重複、cache の回帰検査 |
| `extension/tests/received-translation-cache.test.js` | worker再生成、5日期限、容量不足、削除失敗、読取り専用検索、投稿用翻訳の保存除外。 |
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

## 12. 訳文の順次表示（2026-10-02）

状態: 2026-10-02承認・実装済み。Node test 50件、Python self-check、実モデルSSEと入力KV cache確認は成功。Task 5実Chrome確認は2026-10-02のユーザー報告により合格し、本変更は完了。エージェント自身のChrome接続は利用できなかった。判断は [ADR-007](../adr/007-streaming-translation.md)、外部契約は仕様書SPEC-STREAM-001〜003、実装単位は [active plan](../plans/active/2026-10-02-streaming-translation.md)へ置く。

```text
content script --要求用Port--> service worker / FIFO queue / 訳文LRU
                                       │ 既存のbridge Port
                                       ▼
                              hidden Extension bridge
                                       │ POST / SSE
                                       ▼
                               既存のmlx_lm.server

SSE JSON -> bridge chunk -> worker検証・累積 -> progress -> 同じ訳文body
[DONE]   -> bridge end   -> worker最終検証   -> result   -> 確定・LRU保存
```

| 所有者 | 追加・変更する責務 |
| --- | --- |
| bridge | 固定 streaming payload の境界検証、UTF-8/SSE 解析、chunk/end 通知、既知 job への abort と切断時のreader/AbortController 解放。翻訳内容・成功条件の判断は所有しない。 |
| service worker | 要求用 Port の sender/input 検証、stream content/usage/終了状態の検証と累積、共有 job の購読者管理、最終確定と成功時だけの LRU 保存。実 HTTP は所有しない。 |
| content script | 要求 Port と DOM record の対応、生成中の訳文 body 更新、確定/失敗表示、stale 通知の破棄と購読解除。SSE/API schema は所有しない。 |
| 公式 runtime | モデル推論と既存のメモリ内入力 KV cache。再利用は確認済みで、追加の実装責務はない。 |

job は既存の key、promise、tab ID、deadline に加え、現在の表示可能な累積訳文と購読 callback 集合を保持する。Promise は最終結果を共有し、途中通知は同じ job の購読者へ配信する。先行 job の最初の正規 tab に属する bridge で1回だけ推論し、後から参加した別 tab の正規購読者も自分の要求 Port で受け取る。個別購読解除は共有 job を別 bridge へ移さない。

stream 検証状態は本文、finish reason、usage、終端の有無を必要最小限保持する。既存の成功応答検証へ渡せる最終形へまとめ、同じ reasoning/truncation/空応答条件を適用する。SSE 解析と翻訳検証の責務を混在させず、汎用 stream framework や新依存は作らない。入力 KV cache と訳文 cache を共通の cache 層に統合しない。

content への progress は累積 text 方式に固定し、途中購読の追いつきとUI更新を簡単にする。生成上限 1024 token の範囲で利用し、転送量が実測で問題になる場合だけ差分方式を別判断する。DOM ブロックを token ごとに作り直さず、本文の `textContent` を更新する。

翻訳用one-time `sendMessage`をPortへ置き換え済みで、旧翻訳経路の fallback は残さない。popup、Manifest、モデル、server CLI、queue 並行数と timeout は変更しない。実Chromeでの受け入れ確認は自動検証とは区別し、Task 5のユーザー報告により合格と記録する。

## 13. 投稿前の英語翻訳の設計案（2026-10-05）

状態: 2026-10-05承認・実装済み。自動/実モデル検証済み。実Chrome受け入れはユーザ確認で合格。
外部動作はSPEC-COMPOSE-001〜005を正本とする。
ADR-003、005、006、007の責務境界を維持する。
新しいHTTP経路、汎用翻訳基盤、cache層は追加しない。

| 所有者 | 追加する責務 |
| --- | --- |
| content scriptの投稿入力欄処理 | 入力欄検出、下書き抽出、ボタン、編集世代、購読、完成訳の適用、元の下書きの復元。 |
| service worker | 下書き要求の検証、固定英語prompt、翻訳先の内部伝達、翻訳先を含むkey。 |
| 既存bridge | 既存の固定HTTP/SSE通信を再利用する。翻訳方向の判断は追加しない。 |
| 既存モデル | 固定英語promptによる日本語から英語への翻訳。 |

受信メッセージ処理と投稿入力欄処理は別のrecordで管理する。
投稿入力欄処理は既存content script内の独立した関数群に置く。
Discord固有の検出・抽出・更新は投稿入力欄処理へ限定する。
HTTP、prompt、cacheの判断を投稿入力欄処理へ移さない。

投稿入力欄のrecordは対象要素、投稿先、編集世代を保持する。
要求中は元の下書き、Port、timerをrecordへ保持する。
本文一致だけで古い結果の適用可否を判断しない。
編集や投稿先移動で編集世代を更新し、旧購読を解除する。
個別の購読解除では共有jobを中止しない。
元の下書きは一時的なmemoryだけに保持する。
成功後は直近の翻訳前の下書き1件を復元対象として保持する。
「元に戻す」は翻訳処理を呼ばず、保持した下書きを入力欄へ反映する。
英語訳の反映と下書きの復元は、同じ入力欄の更新処理を使う。
復元対象の保持・破棄はSPEC-COMPOSE-005に従う。
複数世代の履歴や永続保存は追加しない。

workerは要求種別から翻訳先を決定する。
翻訳先はpayload生成とqueueのkey生成まで同じ値を伝える。
日本語promptは維持し、固定英語promptだけを追加する。
cacheと共有jobは同じ翻訳先を含むSHA-256 keyを使用する。
bridgeとworkerの最終検証は既存処理を再利用する。

入力欄の更新は合成`beforeinput`の`insertFromPaste`を使用する。
`DataTransfer`には`text/plain`だけを格納する。
`StaticRange`で入力欄全体を置換対象として指定する。
Slateの編集処理へ渡し、次のイベントループで本文を照合する。
DOMへの直接代入と非公開のReact内部操作は使用しない。
照合に失敗した場合は固定の更新失敗メッセージを表示する。
ユーザ承認により実Chrome確認を実装後へ分離した。
2026-10-05のユーザ実機報告により、新機能の受け入れは合格した。
エージェントによる実Chrome操作は未実施である。
範囲や権限の追加が必要な場合は再承認を得る。

選定根拠は[Slate Editable](https://github.com/ianstormtaylor/slate/blob/main/packages/slate-react/src/components/editable.tsx)、[Slate withDOM](https://github.com/ianstormtaylor/slate/blob/main/packages/slate-dom/src/plugin/with-dom.ts)、[Chromium InputEventInit](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/events/input_event_init.idl)を参照する。

実装順序と検証範囲は [実装計画](../plans/active/2026-10-05-compose-english-translation.md)を参照する。

## 14. 受信翻訳専用の永続キャッシュ案（2026-10-05）

状態: 2026-10-05承認・実装済み。Node自動検証成功。実Chrome受け入れはユーザ確認で合格。
外部動作はSPEC-CACHE-001〜004を正本とする。
第6節、第8節の永続状態を受信完成訳だけに拡張した。
判断は[ADR-008](../adr/008-persist-received-translations.md)に記載する。

### 責務

| 所有者 | 追加する責務 |
| --- | --- |
| content script | 表示メッセージの検索、IDの保持、非同期結果の失効、完成訳の復元。 |
| service workerの受信要求処理 | 検索要求の検証、受信完成訳の保存、保存状態の返却。 |
| 受信翻訳専用の保存処理 | キー、保存値、5日期限、期限切れ削除、Storage APIの境界。 |
| 既存TranslationQueue | 既存の翻訳、重複排除、30分のメモリキャッシュを維持する。 |
| 既存bridge・モデル・投稿入力欄処理 | 永続キャッシュの責務を追加しない。 |

保存処理はworkerから使う独立した関数群とする。
汎用cache framework、repository interface、新依存は作らない。
時計とStorage APIは既存のテスト方式で差し替え可能にする。

### データと競合

保存キーは`receivedTranslation:v1:<messageId>:<sourceHash>`とする。
`sourceHash`は既存の`SHA-256(JSON.stringify(["ja", text.trim()]))`とする。
メッセージIDにはチャンネルIDとメッセージIDが含まれる。
保存値は`{version:1,text,savedAt,expiresAt}`とする。
workerは保存値の版、文字列、有限の時刻、有効期限を検証する。
別メッセージの保存は別キーの書込みとする。
キャッシュ全体のread-modify-writeは使用しない。
同じキーの保存はworker内で直列化し、有効な既存期限を維持する。
期限切れ削除と保存はworker内で競合しない順序にする。
同文であっても別IDのメッセージは自動復元の対象にしない。

### 経路

1. content scriptは表示本文とメッセージIDをrecordへ保持する。
2. content scriptは保存訳の検索だけをworkerへ依頼する。
3. workerはIDと原文hashに対応する有効な完成訳を取得する。
4. content scriptは現在のrecordと本文とIDを照合する。
5. hitの場合は、content scriptが既存の完成訳UIで復元する。
6. missの場合は、content scriptが手動翻訳ボタンを表示する。

手動翻訳は既存queueとbridgeを使う。
workerは有効な受信購読へ完成結果を返す前に保存を試みる。
保存失敗は完成訳と分けて返し、翻訳成功を失敗へ置換しない。
保存開始前に購読が解除された場合は、永続保存を行わない。
保存開始後のページ移動では、保存を取り消さない。
content scriptは保存中の遅延応答にも既存の失効判定を適用する。
検索は翻訳要求用Portとは区別した読取り専用messageで扱う。
workerのlistenerは既存どおり同期登録する。

### 保存境界

`chrome.storage.local`の専用prefixだけを受信保存処理が扱う。
content scriptは保存訳を直接読み書きしない。
既存の`enabled`読取りと変更通知は維持する。
保存訳を`storage.sync`、server、通常ログへ複製しない。
256件の既存LRU制限は5日間の永続領域へ適用しない。
容量上限に達した場合はSPEC-CACHE-004の保存失敗を返す。
worker再生成後はストレージから検索し、memory復旧を前提にしない。
期限切れ削除のための常駐処理や`alarms`権限は追加しない。

実装単位と検証は[実装計画](../plans/active/2026-10-05-received-translation-cache.md)に記載する。

保存処理は`extension/received-translation-cache.js`へ分離した。
Storage APIの操作はworker内で直列化する。
各操作の呼出側は5秒で失敗を受け取る。
Storage API自体の遅延書込みは取消しできない。
操作が未完了の場合は、後続操作の順序を維持する。
タイムアウト済みの操作は、後続の書込みを開始しない。
content scriptは表示recordをMapで保持する。
DOM離脱とID変更は走査時にrecordと表示を削除する。
OFF時は全recordを破棄する。

## 15. 翻訳ボタンのテーマ対応（2026-10-05）

状態: 2026-10-05承認・実装済み。ユーザの実機再確認で合格し、タスク完了。
外部動作はSPEC-THEME-001を正本とする。

### 実装と責務

既存ボタンの配色はDiscordのCSSカスタムプロパティを参照する。
2026-10-05、Discordの公式配布CSSをHTTPで確認した。
旧`--text-normal`と旧hover・focus変数の定義はなかった。
`--background-secondary-alt`の定義は残っていた。
エージェントはユーザ環境のcomputed styleを取得していない。

- `extension/styles.css`が対象ボタンの配色と操作状態を所有する。
- Discordから継承するCSSカスタムプロパティを再利用する。
- 通常背景は不透明な`--background-secondary-alt`を使用する。
- 文字色は`--control-secondary-text-default`を優先する。
- ボタン文字色が未定義の場合は、`--text-default`を使用する。
- hover背景は不透明な`--background-surface-higher`を使用する。
- focusの色は`--border-focus`を使用する。
- 色変数が未定義の場合は、明暗別の固定配色を使用する。
- 代替配色は拡張機能専用のCSSカスタムプロパティへ定義する。
- `.theme-light`内では明色の代替配色を使用する。
- `.theme-dark`、`.theme-darker`、`.theme-midnight`内では暗色を使用する。
- テーマclassがない場合は、暗色の代替配色を使用する。
- 境界線は明暗別の固定色を使用し、背景との境界を示す。
- テーマ変更の反映にはブラウザのCSS再計算を使う。
- `extension/content-script.js`は「再試行」に共通ボタンクラスを付けた。
- 「再試行」の個別CSSを除去し、共通規則を適用した。
- CSSは有効なボタンだけにhoverの配色を適用する。

JavaScriptによるテーマ監視と`matchMedia`は追加しない。
新しい依存関係、権限、テーマ設定、永続状態は追加しない。
UIの状態遷移と翻訳要求の経路は維持する。
文字色の代替値に`inherit`を使用しない。
背景色の代替値に透明色を使用しない。

確認元は[公式テーマCSS](https://discord.com/assets/952007.3a32a6c100854d4e.css)とする。
公式ボタンの色参照は[公式ボタンCSS](https://discord.com/assets/146755.fd230b3ed9402884.css)で確認した。

### 検証方法と確認境界

実Chromeの確認はユーザが行う。
ユーザ承認により、色変数と配色の実機確認を実装後へ分離した。

- 自動検証: `npm --prefix extension test`で既存のボタン動作を確認する。
- 構文検証: `node --check extension/content-script.js`を実行する。
- 差分検証: `git diff --check`を実行する。
- 実Chrome: 両テーマで全対象ボタンの通常と無効状態を確認する。
- 実Chrome: 有効なボタンのhover、Tabによるfocus、文字のコントラストを確認する。
- 実Chrome: ページ再読込なしで両方向のテーマ変更を確認する。
- 実Chrome: テーマ変更後に生成したボタンの配色を確認する。
- 実Chrome: OSとDiscordのテーマが異なる両組合せを確認する。
- 実Chrome: テーマ変更で状態と内容が保持され、翻訳POSTが増えないことを確認する。

Nodeの模擬DOMテストはCSSの描画と配色を検証しない。
実Chromeの確認は自動検証と分けて記録する。

### 検証結果

- `npm --prefix extension test`: 70件成功。
- `node --check extension/content-script.js`: 成功。
- `git diff --check`: 成功。
- 実Chrome受け入れ: ユーザの実機再確認報告により合格。

初回の実機確認では、両テーマで全ボタンの視認性が不合格だった。
旧文字色変数が未定義の場合に親の色を継承する実装を修正した。
背景と文字の代替値を、明暗別の不透明な配色へ変更した。
代替配色の通常・hoverの文字コントラスト比は9.03:1以上である。
コントラスト比は配色値から計算し、実画面の測定とは区別する。
今回の修正はCSSだけであり、成功済みのNode検証は繰り返していない。
2026-10-05、ユーザは修正後の実機再確認で合格と報告した。
ユーザの指定により、テーマ対応のタスクを完了とする。
個別の操作状態の試験内訳とコントラストの実測値は未報告である。
