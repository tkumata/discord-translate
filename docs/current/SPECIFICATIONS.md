# 仕様書

- Status: Current
- Last reviewed: 2026-08-19

## 1. 適用範囲

本書は外部から観測できる動作と境界条件を定義する。要求IDは [要件定義書](REQUIREMENTS.md)、内部責務は [設計書](DESIGN.md) を参照する。server、popup、service worker、bridge、手動翻訳UI、Phase 5.6の既定bridge配線復旧と120秒timeoutは実装・Node自動検証・実Chrome検証済みである。

## 2. サーバ起動仕様

### SPEC-SRV-001 起動入力

対応要求: REQ-F-006, REQ-F-007, REQ-N-002, REQ-N-003, REQ-N-005

`./scripts/start-server.sh` は次の環境変数を受け取る。

| 変数 | 既定値 | 検証 |
| --- | --- | --- |
| `MODEL` | `mlx-community/Qwen3-8B-4bit` | 空、`-`開始、改行・復帰・タブを拒否する。 |
| `PORT` | `8080` | 1〜65535の10進整数だけを許可する。 |
| `CORS_ORIGIN` | なし | `chrome-extension://` と `a`〜`p` の32文字IDだけを許可し、指定を必須とする。 |

不正値または `.venv/bin/mlx_lm.server` 不在時は、標準エラーへ本文を含まない理由を出し、exit code 2で終了する。実装状態: 実装済み。

### SPEC-SRV-002 実行条件

起動スクリプトは `mlx_lm.server` を次の条件で `exec` する。

- host: `127.0.0.1`
- port: `PORT`
- model: `MODEL`
- allowed origin: `CORS_ORIGIN` の1件だけ
- thinking: server側 `enable_thinking=false`
- prompt concurrency: 1
- decode concurrency: 1
- log level: `CRITICAL`
- Hugging Face Hub: `HF_HUB_OFFLINE=1`
- telemetry: `HF_HUB_DISABLE_TELEMETRY=1`

起動中はフォアグラウンドで動作し、`Ctrl-C` で停止する。実装状態: 実装済み・offline再起動確認済み。

## 3. HTTP API仕様

### SPEC-API-001 Chat completion

対応要求: REQ-F-002, REQ-F-003, REQ-F-004, REQ-F-005

- Method: `POST`
- URL: `http://127.0.0.1:<PORT>/v1/chat/completions`
- Content-Type: `application/json`
- Streaming: `false`
- `model`: クライアント要求では省略し、起動時 `MODEL` を使用する。

要求bodyは system message と user message を分離し、次の生成値を使う。

| 項目 | 値 |
| --- | --- |
| `chat_template_kwargs.enable_thinking` | `false` |
| `temperature` | `0.7` |
| `top_p` | `0.8` |
| `top_k` | `20` |
| `min_p` | `0` |
| `max_tokens` | `1024` |
| `stream` | `false` |

`temperature=0`、`repetition_penalty`、`presence_penalty` は現行仕様に含めない。実装状態: APIクライアント用payloadと検証スクリプトに実装済み。

### SPEC-API-002 翻訳prompt

system promptは、日本語への自然な翻訳、翻訳結果のみの出力、Markdown・URL・Discord識別子・コード・製品/API/ライブラリ名・識別子・絵文字の保持、解説と原文反復の禁止を指示する。user本文はsystem promptへ連結せず、独立したuser messageに格納する。実装状態: 実装済み。

### SPEC-API-003 成功応答

次をすべて満たす場合だけ成功とする。

- HTTP 200
- JSON object
- 非空文字列の `choices[0].message.content`
- `finish_reason` が `stop` または現行検証が許容する `tool_calls`
- 整数の `usage.total_tokens`
- `reasoning`、`<think>`、`</think>` が存在しない

表示対象はtrim後の `choices[0].message.content` だけである。実装状態: `scripts/verify.py` とExtension service workerに実装済み。Node自動検証済み。

### SPEC-API-004 Healthとreadiness

- `GET /health` のHTTP 200と `{"status":"ok"}` はHTTPサーバの生存確認とする。
- `GET /v1/models` はロードされたモデル情報の確認に利用できる。
- model readinessは実際の `POST /v1/chat/completions` 成功で判定する。

独自health endpointは追加しない。実装状態: 実機検証済み。

## 4. 翻訳結果仕様

### SPEC-TR-001 不変要素

対応要求: REQ-F-003, REQ-F-004, REQ-F-005

翻訳は自然な日本語を返し、解説と原文反復を追加しない。URL、Markdown、ユーザー名、`@username`、`#channel`、コードブロック、インラインコード、製品名、API名、ライブラリ名、識別子、絵文字は不用意に変更しない。日本語入力は意味を変えない。

固定6ケースのうち日常英語、Discord marker/emoji、code block、日本語、prompt風入力は実ID検証で成功し、serialも成功した。Markdown/URL caseは `**the patch**` 不変条件が未合格であり、生成または検証条件の再確認が必要である。スラング、複数文、Discord実データでの目視品質は未検証であり、仕様適合済みとは扱わない。

## 5. Chrome Extension仕様

以下は現在有効な製品仕様である。popup health、service worker/bridge境界、button押下時だけ依頼する手動翻訳UI、Phase 5.6の既定bridge配線と120秒timeoutは実装・Node自動検証・実Chrome検証済みである。

### SPEC-EXT-001 有効化とメッセージ単位の手動翻訳UI

対応要求: REQ-F-001, REQ-F-009, REQ-F-012

- toolbar actionのpopupに、全Discordタブ共通の`有効` checkboxを1つだけ置く。初期値はOFFとし、`chrome.storage.local`へbooleanの`enabled`だけを保存する。
- OFF→ON操作ではcheckboxを一時disabledにして`接続確認中`と表示し、popup documentから定数`http://127.0.0.1:8080/health`へ`GET`する。`AbortController`で5秒後に中断し、ChromeのLNA promptで許可された後、HTTP 200かつ追加fieldのないJSON object `{"status":"ok"}`の場合だけ`enabled=true`を保存する。
- LNA拒否、timeout、network、HTTP非200、JSON parseまたはschema失敗では`enabled=false`を維持し、本文を含まない日本語状態と固定codeをpopupへ表示する。codeは順に`lna_denied`、`health_timeout`、`health_network_error`、`health_http_error`、`health_invalid_response`とする。ブラウザが拒否を識別可能な`NotAllowedError`を返さない場合は`health_network_error`へ正規化する。
- ON→OFF操作はhealth確認をせず、即時`enabled=false`を保存する。
- OFFでは新しい翻訳要求を作らず、Extensionが挿入した`翻訳`ボタン、訳文、loading、error、`再試行`をすべて除去する。原文には触れない。
- ONへ変更すると、各Discordタブでbridgeと`MutationObserver`を開始し、現在表示中メッセージを1回走査する。以後の新規メッセージも検出するが、この走査・検出・bridge生成では`chrome.runtime.sendMessage`も翻訳POSTも行わない。
- 翻訳可能な各メッセージには初期状態として`翻訳`buttonを1つだけ表示する。button押下時だけ、対象本文について1回の`chrome.runtime.sendMessage`を行う。
- 押下後はbuttonを`翻訳中…`へ切り替えてdisabledにし、同じUI状態からの重複押下と重複message要求を抑止する。
- 成功時は原文を置換せず、対象content要素の直後に`lang="ja"`の訳文を1つ表示する。
- 失敗時は原文を残し、`翻訳できませんでした（<固定error code>）`と`再試行`buttonを同じ位置に表示する。表示するcodeはservice workerが返した既存固定値だけとし、本文、response、`error.message`、URLを表示・logしない。自動retryは行わず、`再試行`押下だけが新しいmessage要求を作る。
- 本文が変わった場合、または対象content要素が差し替えられた場合は、旧本文のloading、訳文、errorを破棄し、新本文用の初期`翻訳`buttonへ戻す。
- `翻訳`、翻訳中、成功、失敗の表示要素にはExtension固有の`data-discord-translate`属性を付け、本文抽出と再走査の対象外にする。

UI状態は `翻訳 -> 翻訳中… -> 訳文` または `翻訳 -> 翻訳中… -> 固定code + 再試行` の最小遷移とする。`再試行`は`翻訳中…`へ戻る。OFF、本文変更、DOM差し替えは進行中結果を表示対象から外し、OFFならUIを除去し、ONの新本文なら`翻訳`へ戻す。実装・Node test・実Chrome検証済みである。

### SPEC-EXT-002 Discord DOM識別と本文

対応要求: REQ-F-001

対象ページはtop frameの`https://discord.com/*`だけとする。壊れやすい生成class名、React内部状態、webpack module、Discord token/APIは使用しない。

実装候補selectorはmessage containerを`li[id^="chat-messages-"]`、本文をその配下の`[id^="message-content-"]`とする。container `id`を`messageId`として扱い、workerへ渡す前に`^chat-messages-[0-9]+-[0-9]+$`へ適合することを確認する。本文はcontent要素の表示文字列をtrimし、空または8,000 UTF-16 code unit超を送らない。訳文表示はcontent要素の直後であり、本文抽出へ混入させない。

このselectorと複数行、code block、link、emoji、編集、仮想scroll、channel遷移は2026-08-18時点の実Chromeで検証済みである。

response受信時に対象containerがDOMから削除済み、content要素が交換済み、または現在のtrim済み本文が要求時と異なる場合は結果を破棄する。ON中で新しいcontent/本文が有効なら、そのメッセージには新本文用の`翻訳`buttonを1つ表示する。queue済み・実行中jobのcancel通信は追加しない。

### SPEC-EXT-003 messagingとtrust boundary

対応要求: REQ-F-009, REQ-F-012, REQ-N-001, REQ-N-004

content scriptはlocalhostを直接fetchせず、利用者が`翻訳`または`再試行`を押したときだけ、次のJSON serializableなone-time messageを`chrome.runtime.sendMessage`でservice workerへ送る。

```json
{"type":"translate","messageId":"chat-messages-<channel>-<message>","text":"<trim済み本文>"}
```

service workerは、`sender.id === chrome.runtime.id`、整数の`sender.tab.id`、`sender.frameId === 0`、`sender.url`のschemeが`https:`かつhostnameが`discord.com`であることを検証する。Chromeの`runtime.MessageSender`で送信元page/frame URLを表す正本は`sender.url`であり、`sender.tab.url`へ依存しない。messageはplain object、`type === "translate"`、上記形式の`messageId`、1〜8,000 UTF-16 code unitの文字列`text`だけを受理し、URLやpayloadを呼出側から受け取らない。不正入力はfetchせず、本文を含まないerror codeを返す。

service workerはSPEC-API-001/002の固定payloadを構築し、翻訳依頼を受理したsenderのtab IDに対応する検証済みbridgeへ渡す。bridgeだけが定数`http://127.0.0.1:8080/v1/chat/completions`、`POST`、`Content-Type: application/json`、120秒timeoutでfetchする。service workerはbridge requestを既定`requestImpl`として使い、global fetchを既定経路にしない。service workerはbridgeのjob ID、envelope、HTTP statusとSPEC-API-003を最終検証し、成功時もtrim済み訳文だけをcontent scriptへ返す。cache hitはbridgeもPOSTも使わず、同一keyのqueued/running jobは既存Promiseを共有するため、1回のbutton押下が常に新しいPOSTを意味するわけではない。

翻訳サーバへのPOSTを開始できる入口は、`翻訳`または`再試行`押下から届いた正規message要求のcache missだけである。DOM走査、`MutationObserver`通知、button/bridge生成、popupのLNA bootstrap用health GET、cache hitは翻訳POSTではない。実装状態: Phase 5.6で`defaultTranslator`を検証済みbridge registryの`requestImpl`へ復旧し、既定経路がservice workerのglobal fetchを呼ばないことをNode testで確認済みである。

service worker、content script、popupは本文・訳文・request/response body、`error.message`、要求URLを`console`へ出さず、通常logと永続storageにも保存しない。service workerは固定error codeだけを返す。SHA-256生成失敗は`hash_error`、翻訳POSTのfetchが`NotAllowedError`または`SecurityError`で拒否された場合は`lna_denied`、自身の120秒abortは`request_timeout`、その他のfetch拒否は`network_error`とする。content scriptはこの固定codeだけを表示し、未知値を`network_error`へ正規化する。popupはhealth状態の固定codeだけを扱い、本文・訳文を送受信しない。

### SPEC-EXT-004 Manifest V3と権限

対応要求: REQ-N-003, REQ-N-010

`manifest_version`は3とし、次だけを宣言する。

- `background.service_worker`: `service-worker.js`。標準Web APIを使うES moduleとして`type: "module"`を指定する。
- `content_scripts`: `matches: ["https://discord.com/*"]`、`js: ["content-script.js"]`、`css: ["styles.css"]`、`run_at: "document_idle"`、`all_frames: false`。
- `action.default_popup`: `popup.html`。
- `permissions`: `storage`だけ。
- `host_permissions`: `http://127.0.0.1:8080/*`だけ。
- `web_accessible_resources`: `resources: ["bridge.html"]`と`matches: ["https://discord.com/*"]`の1組だけ。wildcard resource、`bridge.js`の公開、他originは許可しない。

`tabs`、`activeTab`、`scripting`、`offscreen`、`<all_urls>`、外部network origin、`externally_connectable`、remote codeは追加しない。実Extension IDとサーバの`CORS_ORIGIN`を完全一致させる。OFF→ON時のpopup healthでLNAを事前許可し、翻訳POSTだけをExtension document bridgeで実行する。service workerはqueue/cache、固定payload、timeout監督、HTTP/response最終検証を所有し続ける。server、host permission、新依存は変更しない。

### SPEC-EXT-005 Extension document bridge

対応要求: REQ-F-009, REQ-F-015, REQ-N-001, REQ-N-003, REQ-N-010

- content scriptはON時に`chrome.runtime.getURL("bridge.html")`のiframeをtop tabへ1個だけ追加し、`hidden`、`aria-hidden="true"`、`tabindex="-1"`を設定する。iframe生成だけではPOSTしない。OFF時に削除し、tab unloadではdocumentとPortが破棄される。
- bridgeは固定名の`runtime.Port`でservice workerへ接続する。service workerはExtension ID、bridgeの完全URL、Extension origin、整数tab ID、正の子frame IDを検証する。正規Discord content requestのtab IDと同じPortだけを使用し、tabごとの重複Portを拒否する。
- bridgeは`window.postMessage`、page DOM event、外部messageをlistenしない。Portからもservice worker構築済みの固定shape、job ID、payloadだけを受理し、URL、method、headers、timeoutを入力として受け取らない。
- bridgeは200応答のJSON、HTTP status、固定error codeだけを返す。service workerは未知job、別tab、不正shape、切断を拒否し、最終API responseを自ら検証する。本文、訳文、payload、response、URL、例外messageはlog・storageへ保存しない。
- bridge未接続・切断は`bridge_unavailable`、不正envelopeは`invalid_response`、120秒abortは`request_timeout`、LNA拒否は`lna_denied`、その他fetch拒否は`network_error`、非200は`http_error`へ正規化する。自動無限retryは行わない。
- cache hitはbridgeを使わない。同一keyの重複jobは最初にqueueへ入った正規requestのtab IDへ紐づくbridgeで1回だけ実行し、既存Promiseを共有する。

実装状態: Phase 5.6で既定翻訳経路をbridgeへ配線し、bridge fetchとservice worker job監督を120秒へ揃えた。対象test 22件とExtension全体35件、実Chromeの翻訳動作、25秒超・120秒超case、Port sender field、OFF/unload/disconnect等の異常系は検証済みである。

### SPEC-QUEUE-001 queue、重複排除、cache

対応要求: REQ-F-010, REQ-F-011, REQ-N-007, REQ-N-008

- 所有者: service workerだけ。
- concurrency: 1。FIFOで受け付け順に開始する。
- 上限: runningを含むunique job 64件。同一keyの待受callerは件数へ加えず、上限到達時の新規keyは即時`queue_full`とする。
- queue待機期限: 120秒。開始前に超過したjobは`queue_timeout`としfetchしない。
- 実行期限: 開始後120秒。bridgeの`AbortController`とservice workerのjob監督を同じ値に揃え、到達時は`request_timeout`とする。
- key: `SHA-256(UTF-8(trim済み本文))`のhex。Web Cryptoを使い、本文そのものをMap keyにしない。
- 重複job: 同じkeyのqueued/running Promiseを共有し、server要求を1回にまとめる。
- cache: 成功した訳文だけをmemory `Map`へ最大256件、成功時から30分保存する。hit時に末尾へ移すLRUとし、期限切れと最古entryを削除する。errorはcacheしない。
- service worker停止・Extension reload・Chrome終了: queue、in-flight、cacheをすべて失う。本文・訳文の復旧保存は行わない。未完了`sendMessage`はcontent scriptで失敗表示となり、利用者が手動再試行する。
- DOM削除・本文変更: workerはjobを継続できるが、content scriptが結果を破棄する。cancel protocolは追加しない。

64件は利用者が短時間に押した翻訳要求を有限に収める上限とする。queue待機120秒と実行120秒を別々に適用し、最大処理時間は240秒とする。実行120秒は固定7ケースの一括実行が25秒を超えて継続した実測tailを許容しつつ、Chromeの単一event/API call上限5分未満へ収める有限上限である。永続化、無限待ち、server-side cancellationは追加しない。256件・30分cache、queue 2不採用、server-side cache不採用は維持する。

Chromeは通常、約30秒のidle、1 event/API callの5分超、service worker自身の`fetch()` responseの30秒超でExtension service workerを終了し得る。翻訳HTTPはbridge documentだけが実行し、service workerは`onMessage`から`true`を返して非同期response channelを維持する。Chrome 114以降はlong-lived messagingでのmessage送信がservice worker lifetimeを延長する。listenerはmodule top-levelで同期登録し、global queue/cacheの存続を正しさの前提にしない。最大240秒は単一処理5分未満であり、終了後に失われたcallerはerror UIから再試行する。

## 6. セキュリティ・プライバシー仕様

### SPEC-SEC-001 ネットワーク境界

対応要求: REQ-N-001, REQ-N-002

server listenerはIPv4 `127.0.0.1`だけとし、`0.0.0.0`、LAN IP、IPv6 wildcardを使用しない。loopback listenerは確認済みだが、LAN別端末からの拒否試験は未実施である。

### SPEC-SEC-002 CORS境界

対応要求: REQ-N-003, REQ-N-010

許可originは1つの実Chrome Extension originだけである。`*`、`https://discord.com`、任意originへ `Access-Control-Allow-Origin` を返さない。CORSはブラウザ制御でありローカルプロセス認証ではない。

### SPEC-SEC-003 外部通信

対応要求: REQ-N-001, REQ-N-005

モデル取得は固定の非機密テスト入力で初回だけ行う。通常運用ではcache済みモデルとoffline modeを使い、Discord本文を外部へ送らない。サーバ単体の確認時はloopback以外のTCP接続がなかった。Extensionを含むend-to-end検証は未実施である。

### SPEC-LOG-001 ログ

対応要求: REQ-N-004

通常ログへrequest body、prompt、response、Discord本文を出力・保存しない。検証ツールもbodyを表示・保存しない。観測可能な値はHTTP status、latency、process状態、listener、RSSに限定する。現在のCRITICAL設定でもaccess logはstderrへ出るがbodyは確認されていない。

Extensionのservice workerは、API応答の最終検証が`invalid_response`になった場合だけ、既存のDevTools `console.warn`へ固定ラベル`invalid_response`と次の4項目だけを1件渡す。bridgeはHTTP 200応答のJSON解析に失敗した場合だけ同じshapeを出す。`finish_reason`は文字列だけを値として扱い、それ以外・欠落は`null`とする。`content_present`は`choices[0].message.content`が文字列である場合だけ`true`、`reasoning_present`は`reasoning`/`reasoning_content` fieldまたは`<think>` markerの有無だけ、`usage_total_tokens_present`は非負整数の`usage.total_tokens`の有無だけをbooleanで示す。本文、訳文、payload、response、URL、ID、`error.message`、例外objectは渡さない。成功応答と`invalid_response`以外の失敗ではこの診断logを出さず、storageや外部通信へ保存・送信しない。実Chromeでの失敗条件別件数確認は未実施である。

## 7. エラー時動作

### SPEC-ERR-001 クライアント判定

HTTP非2xx、120秒timeout、接続不能、空body、JSON不正、schema不正、空翻訳、reasoning/thinking、`finish_reason=length` は失敗とする。検証CLIは本文なしの理由と非zero終了を返す。Extensionは原文を保持し、service workerの固定error codeと再試行buttonを示す。`invalid_response`時だけ、仕様ログで定めた4項目の非永続診断をDevTools consoleへ出す。SHA-256境界の失敗は`hash_error`、fetchの`NotAllowedError`/`SecurityError`は`lna_denied`、自身のabortは`request_timeout`、その他のfetch拒否と未知の値は`network_error`へ決定的に正規化する。本文、response、`error.message`、URLは表示・log・storage保存しない。bridge未接続・切断は`bridge_unavailable`とする。

### SPEC-ERR-002 サーバ停止と復旧

サーバ停止中は有限timeout内に失敗し、自動無限retryを行わない。再起動してreadinessが成功した後、新しい要求を処理できること。サーバとExtension経由の起動・停止・再起動は確認済みである。

## 8. OS統合仕様

### SPEC-OS-001 launchd

対応要求: REQ-F-013

基本機能とChrome結合が合格した後、ユーザーLaunchAgentとしてログイン時起動、異常終了時の制御された再起動、明示的start/stop/status、loopback/offline維持、本文を含まないbounded logを提供する。plistと手順は未実装であり、別承認が必要である。

## 9. 性能評価仕様

### SPEC-PERF-001 benchmark

対応要求: REQ-N-009, REQ-N-011

固定の非機密翻訳ケースを使い、model load time、first request latency、subsequent request latency、tokens/sec、peak RSS、連続要求後RSS、目視翻訳品質を同一環境で記録する。比較modelは同じcaseと生成条件を使う。現在は単体generateのtokens/sec・peak memory、server 26件の平均latency・直列最大latency・RSSだけ測定済みであり、load time、first/warm分離、比較modelは未測定である。

## 10. 検証トレーサビリティ

| 検証ID | 対象仕様 | 方法 | 現在結果 |
| --- | --- | --- | --- |
| VAL-001 | SPEC-SRV-001, SRV-002 | shell構文、入力境界、実起動・停止 | 合格 |
| VAL-002 | SPEC-API-001〜004 | `/health`、固定6ケース、schema self-check | 合格（対象ケース内） |
| VAL-003 | SPEC-TR-001 | 固定ケースの不変要素検査 | 実ID検証で5ケースとserialは成功。Markdown/URLの`**the patch**`条件は未合格、網羅的目視未完了 |
| VAL-004 | SPEC-SEC-001 | `lsof` listener確認、LAN別端末試験 | listener合格、LAN試験未実施 |
| VAL-005 | SPEC-SEC-002 | allowed/disallowed origin preflight/POST、popup healthによる実Chrome LNA許可 | 実IDのpreflight、popup health、実Chrome翻訳動作、disallowed originを検証済み |
| VAL-006 | SPEC-SEC-003 | offline再起動、server PIDの接続確認 | サーバ単体合格、E2E未実施 |
| VAL-007 | SPEC-LOG-001 | body非表示、valid/invalid privacy marker検索 | 通常要求のみ確認、marker未実施 |
| VAL-008 | SPEC-QUEUE-001 | 20件・100件直列、順序、RSS推移 | 20件合格、100件未実施 |
| VAL-009 | SPEC-EXT-001〜005, QUEUE-001, ERR-001〜002 | 既定bridge配線、global fetch不使用、bridge/service worker 120秒一致とfake timer境界、既存Node test、unpacked Extension、Discord実UI、25秒超/120秒超case、server停止・復旧 | Phase 5.6対象test 22件、Extension全体35件、実Chrome翻訳、timeout境界、`BrokenPipeError`解消、異常系を検証済み |
| VAL-010 | SPEC-OS-001 | login/start/stop/crash/restart/log試験 | 未実装・未実施 |
| VAL-011 | SPEC-PERF-001 | 同一caseでload、first/warm、tokens/sec、RSS、目視品質を記録 | 一部測定済み |

実測済みserver baselineは26リクエスト全成功、平均1.843秒、直列最大2.113秒、RSS 4,831,392 KBである。Phase 5.6診断の固定7ケースhost実行ではhealthと6ケースが0.786〜2.131秒で成功し、dailyは日本語条件で不合格だった。コマンド全体は25秒を超えて継続し、daily単独再実行はHTTP 200、1.371552秒だった。本文・応答は表示・保存していない。これらは120秒の有限上限と品質再確認の根拠であり、製品全体の合格を意味しない。

## 11. Chrome公式仕様の確認元

2026-08-18に次の一次情報を確認した。Manifest V3の唯一のmanifest version、`background.service_worker`、静的`content_scripts`、host permission、one-time messaging、`chrome.storage`、service workerのidle終了とglobal消失、unpacked load/reload、Local Network Accessの制約を本仕様へ反映している。

- <https://developer.chrome.com/docs/extensions/reference/manifest>
- <https://developer.chrome.com/docs/extensions/reference/manifest/background>
- <https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts>
- <https://developer.chrome.com/docs/extensions/develop/concepts/network-requests>
- <https://developer.chrome.com/docs/extensions/develop/concepts/messaging>
- <https://developer.chrome.com/docs/extensions/reference/api/storage>
- <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- <https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked>
- <https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing>
- <https://developer.chrome.com/blog/local-network-access>
