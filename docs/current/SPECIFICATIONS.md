# 仕様書

2026-10-02承認のstreamingを実装済み。第12節に通信・表示の詳細と入力KV cacheの実機確認結果を記載する。実ChromeもユーザーのTask 5実機確認により合格した。

- Status: Current
- Last reviewed: 2026-10-22
- Native startup: SPEC-PROVIDER-007 は完了。実 Chrome はユーザ確認で合格。
- Approved addition: 第13節は実装・自動/実モデル検証済み。実Chrome受け入れはユーザ確認で合格。
- Theme addition: 第15節は完了。実機受け入れはユーザの再確認で合格。

## 1. 適用範囲

本書は外部から観測できる動作と境界条件を定義する。要求IDは [要件定義書](REQUIREMENTS.md)、内部責務は [設計書](DESIGN.md) を参照する。旧方式のserver、popup、service worker、bridge、手動翻訳UIとPhase 5.6の配線・timeoutは実Chrome検証済み。順次表示はNode/実モデル検証済み、実ChromeもTask 5でユーザー確認済みである。

## 2. サーバ起動仕様

### SPEC-SRV-001 起動入力

対応要求: REQ-F-006, REQ-F-007, REQ-N-002, REQ-N-003, REQ-N-005

`./scripts/start-server.sh` は次の環境変数を受け取る。

| 変数 | 既定値 | 検証 |
| --- | --- | --- |
| `MODEL` | `mlx-community/Qwen3.5-9B-MLX-4bit` | 空、`-`開始、制御空白、台帳未登録値を拒否する。 |
| `PORT` | `8080` | 1〜65535の10進整数だけを許可する。 |
| `CORS_ORIGIN` | なし | `chrome-extension://` と `a`〜`p` の32文字IDだけを許可し、指定を必須とする。 |

不正値または `.venv/bin/mlx_lm.server` 不在時は、標準エラーへ本文を含まない理由を出し、exit code 2で終了する。実装状態: 実装済み。

### SPEC-SRV-002 実行条件

起動スクリプトは `mlx_lm.server` を次の条件で `exec` する。

- host: `127.0.0.1`
- port: `PORT`
- model: 台帳と照合したモデルの絶対ローカルパス
- allowed origin: `CORS_ORIGIN` の1件だけ
- thinking: server側 `enable_thinking=false`
- prompt concurrency: 1
- decode concurrency: 1
- log level: `CRITICAL`
- Hugging Face Hub: `HF_HUB_OFFLINE=1`
- telemetry: `HF_HUB_DISABLE_TELEMETRY=1`

起動中はフォアグラウンドで動作し、`Ctrl-C` で停止する。実装状態: 実装済み・offline再起動確認済み。

起動前のモデル検証は SPEC-SUPPLY-002 を参照する。
通常起動は依存導入とモデル取得を行わない。

## 3. HTTP API仕様

### SPEC-API-001 Chat completion

対応要求: REQ-F-002, REQ-F-003, REQ-F-004, REQ-F-005

- Method: `POST`
- URL: `http://127.0.0.1:<PORT>/v1/chat/completions`
- Content-Type: `application/json`
- Streaming: `true`（SSE）
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
| `stream` | `true` |
| `stream_options.include_usage` | `true` |

`temperature=0`、`repetition_penalty`、`presence_penalty` は現行仕様に含めない。実装状態: APIクライアント用payloadと検証スクリプトに実装済み。

### SPEC-API-002 翻訳prompt

system promptは、日本語への自然な翻訳、翻訳結果のみの出力、Markdown・URL・Discord識別子・コード・製品/API/ライブラリ名・識別子・絵文字の保持、解説と原文反復の禁止を指示する。user本文はsystem promptへ連結せず、独立したuser messageに格納する。実装状態: 実装済み。

下書き要求ではSPEC-COMPOSE-004の固定英語promptを使用する。

### SPEC-API-003 成功応答

SSEをSPEC-STREAM-001に従って累積し、HTTP 200、非空訳文、`finish_reason=stop`、非負整数`usage.total_tokens`、reasoning/thinking不在、`[DONE]`をすべて確認した場合だけ成功とする。途中表示は成功ではなく、cacheへ保存しない。最終確定時だけ訳文をtrimする。

実装状態: Extensionと検証CLIに実装済み。Node test、固定非機密の実モデルstreaming検証は成功、実Chromeも2026-10-02のユーザーによるTask 5実機確認で合格。

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

以下は現在有効な製品仕様である。popup healthと旧方式の手動翻訳・bridge配線・timeoutは実Chrome検証済み。順次表示の実ChromeもユーザーのTask 5実機確認により合格した。

### SPEC-EXT-001 有効化とメッセージ単位の手動翻訳UI

対応要求: REQ-F-001, REQ-F-009, REQ-F-012

- toolbar actionのpopupに、全Discordタブ共通の`有効` checkboxを1つだけ置く。初期値はOFFとし、`chrome.storage.local`へ設定としてbooleanの`enabled`を保存する。受信完成訳の保存はSPEC-CACHE-001〜004に従う。
- OFF→ON操作ではcheckboxを一時disabledにして`接続確認中`と表示し、popup documentから定数`http://127.0.0.1:8080/health`へ`GET`する。`AbortController`で5秒後に中断し、ChromeのLNA promptで許可された後、HTTP 200かつ追加fieldのないJSON object `{"status":"ok"}`の場合だけ`enabled=true`を保存する。
- LNA拒否、timeout、network、HTTP非200、JSON parseまたはschema失敗では`enabled=false`を維持し、本文を含まない日本語状態と固定codeをpopupへ表示する。codeは順に`lna_denied`、`health_timeout`、`health_network_error`、`health_http_error`、`health_invalid_response`とする。ブラウザが拒否を識別可能な`NotAllowedError`を返さない場合は`health_network_error`へ正規化する。
- ON→OFF操作はhealth確認をせず、即時`enabled=false`を保存する。
- OFFでは新しい翻訳要求を作らず、Extensionが挿入した`翻訳`ボタン、訳文、loading、error、`再試行`をすべて除去する。原文には触れない。
- ONへ変更すると、各Discordタブでbridgeと`MutationObserver`を開始し、現在表示中メッセージを1回走査する。以後の新規メッセージも検出するが、この走査・検出・bridge生成では翻訳要求Portも翻訳POSTも開始しない。
- 翻訳可能な各メッセージでは初回に保存訳を検索する。有効な保存訳は完成表示へ復元し、missでは`翻訳`buttonを1つ表示する。検索中は`確認中…`としてbuttonをdisabledにする。button押下時だけ、対象本文について1つの要求用Portを開き、1回の翻訳要求を送る。
- 押下後はbuttonを`翻訳中…`へ切り替えてdisabledにし、同じUI状態からの重複押下と重複message要求を抑止する。
- 成功時は原文を置換せず、対象content要素の直後に`lang="ja"`の訳文ブロックを1つ表示する。先頭に小さな太字の`日本語訳`ラベルを置き、上余白8px、左の細線、薄い背景、内側余白で原文との境界と訳文の範囲を示す。訳文は通常の本文色と改行を維持し、色はDiscordのテーマ変数に合わせる。
- 失敗時は原文を残し、`翻訳できませんでした（<固定error code>）`と`再試行`buttonを同じ位置に表示する。表示するcodeはservice workerが返した既存固定値だけとし、本文、response、`error.message`、URLを表示・logしない。自動retryは行わず、`再試行`押下だけが新しいmessage要求を作る。
- 本文、メッセージID、対象content要素が変わった場合は旧対象の表示を破棄する。新しい対象はSPEC-CACHE-003に従って保存訳を検索する。
- `翻訳`、翻訳中、成功、失敗の表示要素にはExtension固有の`data-discord-translate`属性を付け、本文抽出と再走査の対象外にする。

UI状態は`翻訳 -> 翻訳中… -> 日本語訳（翻訳中…） -> 日本語訳`とする。失敗時は部分訳を除去して`固定code + 再試行`へ進む。表示・購読解除の詳細はSPEC-STREAM-003を参照する。`再試行`は`翻訳中…`へ戻る。OFF、本文変更、DOM差し替えは進行中結果を表示対象から外し、OFFならUIを除去し、ONの新本文なら`翻訳`へ戻す。順次表示は実装・Node test済み、実ChromeもTask 5でユーザー確認済みである。

### SPEC-EXT-002 Discord DOM識別と本文

対応要求: REQ-F-001

対象ページはtop frameの`https://discord.com/*`だけとする。壊れやすい生成class名、React内部状態、webpack module、Discord token/APIは使用しない。

実装候補selectorはmessage containerを`li[id^="chat-messages-"]`、本文をその配下の`[id^="message-content-"]`とする。container `id`を`messageId`として扱い、workerへ渡す前に`^chat-messages-[0-9]+-[0-9]+$`へ適合することを確認する。本文はcontent要素の表示文字列をtrimし、空または8,000 UTF-16 code unit超を送らない。訳文表示はcontent要素の直後であり、本文抽出へ混入させない。

このselectorと複数行、code block、link、emoji、編集、仮想scroll、channel遷移は2026-08-18時点の実Chromeで検証済みである。

response受信時に対象containerがDOMから削除済み、content要素が交換済み、または現在のtrim済み本文が要求時と異なる場合は結果を破棄する。ON中で新しいcontent/本文が有効なら、そのメッセージには新本文用の`翻訳`buttonを1つ表示する。queue済み・実行中jobのcancel通信は追加しない。

### SPEC-EXT-003 messagingとtrust boundary

対応要求: REQ-F-009, REQ-F-012, REQ-N-001, REQ-N-004

content scriptはlocalhostを直接fetchせず、利用者が`翻訳`または`再試行`を押したときだけ、固定名`discord-translate-request`の要求用Portで次のJSON serializableなmessageをservice workerへ1回だけ送る。Portの詳細はSPEC-STREAM-002に従う。

投稿入力欄の要求はSPEC-COMPOSE-002、004の`translateDraft`に従う。

```json
{"type":"translate","messageId":"chat-messages-<channel>-<message>","text":"<trim済み本文>"}
```

service workerは、`sender.id === chrome.runtime.id`、整数の`sender.tab.id`、`sender.frameId === 0`、`sender.url`のschemeが`https:`かつhostnameが`discord.com`であることを検証する。Chromeの`runtime.MessageSender`で送信元page/frame URLを表す正本は`sender.url`であり、`sender.tab.url`へ依存しない。messageはplain object、`type === "translate"`、上記形式の`messageId`、1〜8,000 UTF-16 code unitの文字列`text`だけを受理し、URLやpayloadを呼出側から受け取らない。不正入力はfetchせず、本文を含まないerror codeを返す。

service workerはSPEC-API-001/002の固定payloadを構築し、翻訳依頼を受理したsenderのtab IDに対応する検証済みbridgeへ渡す。bridgeだけが定数`http://127.0.0.1:8080/v1/chat/completions`、`POST`、`Content-Type: application/json`、120秒timeoutでfetchする。service workerはbridge requestを既定`requestImpl`として使い、global fetchを既定経路にしない。service workerはbridgeのjob ID、envelope、HTTP statusとSPEC-API-003を最終検証し、検証済み途中textと、最終成功時のtrim済み訳文をcontent scriptへ返す。cache hitはbridgeもPOSTも使わず、同一keyのqueued/running jobは既存Promiseを共有するため、1回のbutton押下が常に新しいPOSTを意味するわけではない。

翻訳サーバへのPOSTを開始できる入口は、`翻訳`、`再試行`、`英語に翻訳`の押下から届いた正規要求のcache missだけである。DOM走査、`MutationObserver`通知、button/bridge生成、popupのLNA bootstrap用health GET、cache hit、`元に戻す`は翻訳POSTではない。実装状態: Phase 5.6で`defaultTranslator`を検証済みbridge registryの`requestImpl`へ復旧し、既定経路がservice workerのglobal fetchを呼ばないことをNode testで確認済みである。

service worker、content script、popupは本文・訳文・request/response body、`error.message`、要求URLを`console`へ出さず、通常logにも保存しない。永続storageにはSPEC-CACHE-001〜004の受信完成訳と識別情報だけを例外として保存する。service workerは固定error codeだけを返す。SHA-256生成失敗は`hash_error`、翻訳POSTのfetchが`NotAllowedError`または`SecurityError`で拒否された場合は`lna_denied`、自身の120秒abortは`request_timeout`、その他のfetch拒否は`network_error`とする。content scriptはこの固定codeだけを表示し、未知値を`network_error`へ正規化する。popupはhealth状態の固定codeだけを扱い、本文・訳文を送受信しない。

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
- bridgeはSSEのJSON chunk、終端、非200のHTTP status、固定error codeだけを返す。service workerは未知job、別tab、不正shape、切断を拒否し、最終API responseを自ら検証する。本文、訳文、payload、response、URL、例外messageはlog・storageへ保存しない。
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
- key: `SHA-256(UTF-8(JSON.stringify([翻訳先, trim済み本文])))`のhex。翻訳先は`ja`または`en`。Web Cryptoを使い、本文そのものをMap keyにしない。
- 重複job: 同じkeyのqueued/running Promiseを共有し、server要求を1回にまとめる。
- cache: 成功した訳文だけをmemory `Map`へ最大256件、成功時から30分保存する。hit時に末尾へ移すLRUとし、期限切れと最古entryを削除する。errorはcacheしない。
- service worker停止・Extension reload・Chrome終了: queue、in-flight、memory cacheを失う。未完了jobの復旧保存は行わない。受信完成訳の永続キャッシュはSPEC-CACHE-001〜004に従って保持する。未完了の要求Portはcontent scriptで失敗表示となり、利用者が手動再試行する。
- DOM削除・本文変更: workerはjobを継続できるが、content scriptが結果を破棄する。cancel protocolは追加しない。

64件は利用者が短時間に押した翻訳要求を有限に収める上限とする。queue待機120秒と実行120秒を別々に適用し、最大処理時間は240秒とする。実行120秒は固定7ケースの一括実行が25秒を超えて継続した実測tailを許容しつつ、Chromeの単一event/API call上限5分未満へ収める有限上限である。未完了jobの永続化、無限待ち、server-side cancellationは追加しない。256件・30分cache、queue 2不採用、製品固有のserver-side訳文cache不採用は維持する。既存の入力KV cacheは再利用する。

Chromeは通常、約30秒のidle、1 event/API callの5分超、service worker自身の`fetch()` responseの30秒超でExtension service workerを終了し得る。翻訳HTTPはbridge documentだけが実行し、service workerは要求用Portでprogress/result/errorを送る。Portの開設だけでlifetimeは保証せず、contentも最大240秒の監督timerを持つ。Chrome 114以降はlong-lived messagingでのmessage送信がservice worker lifetimeを延長する。listenerはmodule top-levelで同期登録し、global queue/cacheの存続を正しさの前提にしない。最大240秒は単一処理5分未満であり、終了後に失われたcallerはerror UIから再試行する。

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

Extensionのservice workerは、API応答の最終検証が`invalid_response`になった場合だけ、既存のDevTools `console.warn`へ固定ラベル`invalid_response`と次の4項目だけを1件渡す。bridgeはHTTP 200のSSE構文、Content-Type、buffer上限、終端の検証に失敗した場合だけ同じshapeを出す。`finish_reason`は文字列だけを値として扱い、それ以外・欠落は`null`とする。`content_present`は`choices[0].message.content`またはstream eventの`choices[0].delta.content`が文字列である場合だけ`true`、`reasoning_present`は`reasoning`/`reasoning_content` fieldまたは`<think>` markerの有無だけ、`usage_total_tokens_present`は非負整数の`usage.total_tokens`の有無だけをbooleanで示す。本文、訳文、payload、response、URL、ID、`error.message`、例外objectは渡さない。成功応答と`invalid_response`以外の失敗ではこの診断logを出さず、storageや外部通信へ保存・送信しない。実Chromeでの失敗条件別件数確認は未実施である。

## 7. エラー時動作

### SPEC-ERR-001 クライアント判定

HTTP非2xx、120秒timeout、接続不能、空body、JSON/SSE不正、schema不正、終端欠落、空翻訳、reasoning/thinking、`finish_reason=length` は失敗とする。検証CLIは本文なしの理由と非zero終了を返す。Extensionは原文を保持し、service workerの固定error codeと再試行buttonを示す。`invalid_response`時だけ、仕様ログで定めた4項目の非永続診断をDevTools consoleへ出す。SHA-256境界の失敗は`hash_error`、fetchの`NotAllowedError`/`SecurityError`は`lna_denied`、自身のabortは`request_timeout`、その他のfetch拒否と未知の値は`network_error`へ決定的に正規化する。本文、response、`error.message`、URLは表示・log・storage保存しない。bridge未接続・切断は`bridge_unavailable`とする。

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

## 12. 訳文の順次表示と入力KV cache（2026-10-02）

状態: 2026-10-02承認・実装済み。Node test 50件、Python self-check、実モデルSSE/KV検証は成功。実Chromeは2026-10-02のユーザーによるTask 5実機確認で問題なしと報告され、本変更は完了。SPEC-API/EXT/QUEUE/ERRの該当契約を同期した。

### SPEC-STREAM-001 要求と stream 応答

- 固定URL、POST、同じ system/user message、thinking 無効、sampling、`max_tokens=1024` を維持し、`stream=true` と `stream_options={"include_usage":true}` だけを追加・変更する。model 指定は引き続き省略する。
- bridge が `fetch` の HTTP 200 かつ `text/event-stream` を確認し、標準 `ReadableStream`/`TextDecoder` で SSE を解析する。bridge は通信形式だけを扱い、翻訳内容の最終検証は service worker が所有する。
- UTF-8 途中分割、LF/CRLF/CR、空行による event 境界、1回の read に複数 event、複数 read にまたがる event、複数 `data:` 行に対応する。コメント、`id`/`retry` 等の SSE 制御 field を訳文にしない。JSON ではないdata、不正 frame、終端前EOFは `invalid_response` とする。
- JSON event は追加分の `choices[0].delta.content`、終了choice、`choices=[]` の usage 専用 event として検証する。role だけの chunk と空 content は許容し、未知の role、tool call、reasoning field、分割された `<think>`/`</think>` を含む内容は拒否する。think marker になり得る末尾断片は判定まで表示を保留する。
- service worker が content を順に累積する。途中では空白・改行を trim せず、最終確定時だけ既存どおり trim する。解析待ち buffer は 1 MiB、累積 content は 64 Ki UTF-16 code unit を上限とし、超過は `invalid_response` とする。
- 非空の訳文、`finish_reason=stop`、reasoning不在、非負整数 `usage.total_tokens`、`data: [DONE]` をすべて確認して初めて成功とする。usage は最終 choice より後に届くため、それ以前に成功・cache 保存しない。
- 非 200、timeout、ネットワーク失敗、不正応答、`finish_reason=length` は既存の固定 error へ正規化する。成功・失敗・通信切断時に reader と timer を解放し、失敗時は bridge 自身の `AbortController` で残りの読取りを終了する。

### SPEC-STREAM-002 Extension 内の通信と重複要求

- content script はボタン押下時だけ、固定名 `discord-translate-request` の `runtime.Port` を開く。1つの Port で既存 shape の `{type:"translate",messageId,text}` を1回だけ受理する。Port 接続だけでは POST しない。
- 下書き翻訳も同じPortで`{type:"translateDraft",text}`を1回だけ受理する。
- service worker は既存の正規 Discord top frame sender/input 検証を適用する。bridge Port とは固定名・frame・URLの検証を分け、未知 Port や再要求、不正 shape を拒否する。
- service worker から content へ送る shape は `{type:"progress",text}`、`{type:"result",text}`、`{type:"error",error}` とする。受信完成結果だけはSPEC-CACHE-004の保存状態を添える。`progress.text` はその時点の累積訳文で、`result.text` だけが確定訳文である。Port と record が対応するため、content 側に新しい job ID を持たせない。
- bridge は既存の検証済み Port で `{type:"chunk",jobId,payload}` を各 JSON event ごとに送り、`[DONE]` 受信後に `{type:"end",jobId}` を送る。非 200 の status と固定 error は既存 envelope を維持する。chunk で pending を完了せず、別 tab・未知 job・終端後の通知を表示へ流さない。
- worker が検証失敗または実行 timeout で job を終了するときは、同じ bridge Port へ固定 shape の `{type:"abort",jobId}` を送り、bridge がその既知 job の reader/fetch を停止する。bridge 切断時も pending reader を停止する。これは HTTP 読取りの解放であり、利用者操作による個別 job cancel や server-side cancellation は追加しない。
- queue の同一本文 job には複数の購読者を登録できる。途中参加者へ現在の累積訳文を1回送り、その後の更新と終端を共有する。POST は1回、cache hit は確定全文を1回返す。失敗・部分訳は cache へ保存しない。
- OFF、本文変更、DOM 交換、Port 切断では購読を解除する。個別購読解除は共有推論 job を cancel せず、残る購読者へ通知を継続する。content は終端受信後に自身の Port を閉じ、予期しない切断では現在の record にだけ `network_error` を表示する。
- queue 並行数1、最大 64 unique job、待機 120秒、実行 120秒、訳文 cache 256 件/30分は維持する。実行 timeout は stream 全体の絶対期限で、chunk 到着ごとに延長しない。
- Portを開くだけでworker lifetimeを保証しない。worker終了は有限の失敗と手動再試行で扱い、listenerはtop-levelで同期登録する。contentも要求から最大240秒で未完了購読を失敗にし、Port/timerを解放する。

### SPEC-STREAM-003 表示と失敗

- 最初の非空progressを受けるまでは既存のdisabledな`翻訳中…`を表示する。
- 最初のprogressで原文直下に既存の`lang="ja"`、`data-discord-translate="translation"`のブロックを1つ作り、ラベルを`日本語訳（翻訳中…）`とする。以降は同じ本文要素の`textContent`を更新する。
- 正常なresultでラベルを`日本語訳`にし、確定全文へ更新する。cache hitは途中状態を経由せず、この完成表示へ進める。
- 失敗時は部分訳を除去し、既存の固定errorと`再試行`へ戻す。原文は保持し、自動retryはしない。
- すべてのprogress/result/errorで現在のrecord、enabled、container/contentの接続、対象本文の一致を再確認する。OFF・編集・DOM交換後の通知は破棄する。
- 本文はHTMLとして解釈せず改行を保持する。状態の案内は`role="status"`/`aria-live="polite"`等で提供し、訳文本体のtoken単位読み上げは要求しない。新しいbuttonや設定項目は追加しない。

### SPEC-KV-001 既存入力 KV cache の確認結果

2026-10-02、既存 `server.sh` を変更せず起動し、`/health` の HTTP 200 と `/v1/models` の `mlx-community/Qwen3-8B-4bit` を確認した。移行前のExtensionと同じsystem prompt・非streaming payloadで、異なる固定非機密英文を3件直列送信した。

| 要求 | HTTP | elapsed | prompt tokens | completion tokens | cached tokens | finish reason | reasoning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 | 2.6584秒 | 81 | 11 | 0 | stop | なし |
| 2 | 200 | 0.8657秒 | 81 | 10 | 66 | stop | なし |
| 3 | 200 | 1.1625秒 | 84 | 14 | 66 | stop | なし |

- 結論: 入力KV cacheは有効で、異なる原文間で共通prefixを再利用している。有効化の設定・コード追加は不要。
- 境界: 公式runtimeのメモリ内KV cacheであり、Extensionの成功訳文LRUやモデルファイルcacheとは別物。server再起動後のhitは保証しない。永続cacheや独自serverは追加しない。
- 測定条件: 本文・訳文を出力・保存せず、metadataだけを観測した。時間差には出力長や初回処理も含まれ、cacheだけの短縮率とは断定しない。この表は移行前の測定で、移行後の結果は次の記録を参照する。測定時点ではChrome描画を確認していない。Task 5の実画面受け入れ確認は後続のユーザー報告により合格。
- 移行後: 同じモデル・system promptで異なる固定英文のstreaming要求を行い、usage eventの`prompt_tokens_details.cached_tokens > 0`を再確認済み。既存のKV cacheが効く限りserver起動設定を変更しない。
- SPEC-LOG-001の例外として、固定非機密入力の手動検証に限りmodel名、prompt/completion/cached token数、finish reason、reasoning有無を記録できる。通常のDiscord要求には新しい性能logを追加しない。

参照: [MLX-LM 0.31.3 API](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/SERVER.md)、[server実装](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/server.py)、[SSE標準](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)。

#### streaming移行後の確認結果（2026-10-02）

- `./.venv/bin/python scripts/verify.py --streaming --count 2`: 固定6ケースと異なる直列2件が全件成功。初回content 1.175秒、後続content 0.402〜0.420秒、完了0.719〜1.915秒。各要求は6〜25個の非空content chunkを受信した。
- 入力KV cache: 初回0 token、後続7件66〜68 token。同じExtension promptと生成設定で異なる原文の再利用を再確認した。server CLI変更なし。
- 実モデル→実装済みbridge SSE→worker queue/dedup/LRUの結合: 最初のprogress 493ms、完了2141ms、30 progress、重複/再利用を含めPOST 1回、終了後pending 0。Chrome Port部分は検証用の接続であり実Chrome検証ではない。
- 本文・訳文は出力・保存していない。時刻はAPI/progress受信時刻で、実画面の初回描画時刻や高速化率を表さない。実ChromeのTask 5受け入れ確認は、2026-10-02のユーザー報告「問題ないです」により合格。エージェントのChrome接続は利用できず、実機確認の証拠はユーザー報告である。

## 13. 投稿前の英語翻訳の仕様案（2026-10-05）

状態: 2026-10-05承認・実装済み。各要求のレベルはMUSTとする。
自動/実モデル検証は成功した。Discord実画面の機能受け入れはユーザ確認で合格した。
要求はREQ-F-018〜025、受け入れ条件はAC-019〜025に対応する。
英語訳の下書き反映、編集継続、「元に戻す」はユーザ指定で確定した。

### SPEC-COMPOSE-001 対象とボタン

- ON中は通常の投稿入力欄の近くに「英語に翻訳」を1つ表示する。
- 対象はチャンネル、DM、スレッドの新規投稿入力欄とする。
- 投稿済みメッセージの編集欄や検索欄は対象外とする。
- 初期対応はプレーンテキストの下書きとする。
- 改行、Markdown、URL、コード、Unicode絵文字を扱う。
- メンションなどの非テキスト要素を含む下書きは変更しない。
- 非対応の下書きではボタンを無効にし、理由を表示する。
- 添付ファイルの追加・削除・変更は行わない。
- 空白のみ、8,000 UTF-16コード単位超過では要求を送らない。
- 入力上限はtrim後の本文に適用する。
- 日本語の自動判定は追加しない。
- ボタンは`type="button"`とし、フォーム送信を起こさない。
- ボタンはクリックと標準のキーボード操作で利用できる。
- 状態の案内は`role="status"`等で提供する。
- OFFではボタンと状態表示を除去し、下書きは変更しない。

対象判定と更新方法は実Chromeで確認する。
Discordの非テキスト要素を単純な`textContent`へ平坦化しない。
安全に更新できない入力欄ではボタンを有効にしない。

候補はform内の`[role="textbox"][contenteditable="true"][data-slate-editor="true"]`とする。
投稿済みメッセージとdialogの内部は候補から除外する。
本文はSlateのblockとleafから抽出する。
非テキスト要素や未知の本文構造は翻訳対象から除外する。

### SPEC-COMPOSE-002 要求と生成中の動作

- ボタン押下時、入力欄・投稿先・編集世代・下書きを記録する。
- 要求本文は下書きのtrim済みテキストとする。
- 元の下書きは空白と改行を含めて保持する。
- 1押下で既存の要求用Portを1つ開く。
- 要求shapeは`{type:"translateDraft",text}`とする。
- 下書きの要求に投稿済みメッセージのIDを流用しない。
- 生成中はボタンを「翻訳中…」にし、重複押下を抑止する。
- 生成中も利用者は下書きを編集できる。
- `progress`を受信しても入力欄へ部分訳を書き込まない。
- 入力、DOM検出、有効化だけでは翻訳要求を送らない。

### SPEC-COMPOSE-003 成功・失敗・古い結果

- 正常な`result`だけを入力欄へ1回適用する。
- 適用前にenabled、入力欄の接続、投稿先、編集世代を検証する。
- 適用前に空白を含む下書き全体の一致を検証する。
- 編集後に同じ本文へ戻した場合も、旧世代の結果を破棄する。
- 編集、投稿先移動、入力欄交換、OFF後は購読を解除する。
- 古い`progress`、`result`、`error`は現在の下書きへ適用しない。
- 翻訳中に利用者が投稿した場合も、古い結果を破棄する。
- 成功時は入力欄全体を完成した英語訳へ置き換える。
- 置換後は入力欄で編集を続けられる状態にする。
- 置換はDiscordの編集状態へ反映する。
- 成功時は「元に戻す」ボタンを表示する。
- 拡張機能は送信ボタンの押下、Enterの生成、投稿API呼び出しを行わない。
- 利用者による通常の投稿操作は変更しない。
- 失敗時は下書きを保持し、既存の固定error codeを表示する。
- 失敗時は同じボタンを再度有効にし、手動再試行を受け付ける。
- 自動再試行は行わない。
- content側の監督期限は既存の最大240秒を維持する。
- 終端、購読解除、切断ではPortとtimerを解放する。

DOMへの`textContent`代入だけでは更新成功と扱わない。
実Chromeで表示、編集継続、Discordの下書き状態を確認する。
確認に使う下書きは固定の非機密テキストとする。

### SPEC-COMPOSE-004 翻訳方向と共有経路

- workerは既存の`translate`要求を日本語訳として受理する。
- workerは`translateDraft`要求を英語訳として受理する。
- 新要求はplain objectの`type`と`text`だけを許可する。
- sender検証と1Port1要求の制限は既存の規則を適用する。
- workerは要求種別から翻訳先`ja`または`en`を決定する。
- 呼び出し側から任意のprompt、URL、API payloadを受け取らない。
- 英語promptは自然な英語への翻訳と訳文だけの出力を指示する。
- 英語promptは改行、Markdown、URL、コード、識別子、絵文字の保持を指示する。
- user本文は独立したuser messageに格納する。
- keyは`SHA-256(UTF-8(JSON.stringify([翻訳先, trim済み本文])))`とする。
- keyは重複jobと訳文cacheの両方へ適用する。
- 同じ本文でも、異なる翻訳先のjobとcacheを共有しない。
- 同じ翻訳先と本文では既存の重複排除を維持する。
- bridgeは既存の固定payloadとSSE通信を使用する。
- 正常終了、usage、終端、thinking不在の最終検証を維持する。
- queue、timeout、cache上限、モデル、生成設定は変更しない。
- 権限、popup、サーバ、新しい依存関係は変更しない。
- 本文と訳文の永続化禁止は下書きにも適用する。

SPEC-EXT-003、SPEC-QUEUE-001、SPEC-STREAM-002へ追加仕様を同期した。
受信メッセージの既存動作はNode testで回帰確認した。

### SPEC-COMPOSE-005 「元に戻す」ボタン

- 英語訳の反映後は「英語に翻訳」の近くに「元に戻す」を表示する。
- ボタン押下時、同じ入力欄を翻訳直前の下書き全体へ戻す。
- 空白と改行は翻訳直前の状態へ戻す。
- 英語訳を編集した後も、ボタンで翻訳直前の下書きへ戻せる。
- 復元時は英語訳へ加えた編集も置き換える。
- 復元対象は直近の成功した翻訳の直前の下書き1件とする。
- 次の翻訳が成功した場合は、復元対象を更新する。
- 次の翻訳が失敗した場合は、以前の復元対象を保持する。
- 翻訳中は「元に戻す」を無効にする。
- 復元処理はDiscordの編集状態へ反映する。
- 復元後は入力欄で編集を続けられる状態にする。
- 復元後は「元に戻す」を除去し、復元対象を破棄する。
- 投稿、入力欄の空化、投稿先移動、入力欄交換、OFFでは復元対象を破棄する。
- 復元対象を破棄した場合は「元に戻す」を除去する。
- 復元対象は同じ入力欄のmemoryだけに保持する。
- 復元で翻訳要求や投稿操作を実行しない。
- 復元で添付ファイルを変更しない。
- ボタンは`type="button"`とし、標準のキーボード操作で利用できる。
- 復元が失敗した場合は成功扱いせず、復元対象を保持する。

### 検証結果と確認範囲

- `npm --prefix extension test`: 58件成功。
- `./.venv/bin/python scripts/verify.py --self-check`: 成功。
- 変更JSの`node --check`と`git diff --check`: 成功。
- 実モデルと既存bridge/worker処理: 英訳3ケースと日本語訳1ケース成功。
- 英訳の固定ケース: 日常文、改行・URL・インラインコード・絵文字、コードブロック。
- 本文と訳文は検証ログへ出力・保存していない。
- 2026-10-05、ユーザが「新規に追加した機能は意図とおり」と実機確認を報告した。
- 新機能の実Chrome受け入れはユーザ確認により合格とする。
- 個別の異常系・画面別の実機試験内訳は未報告である。
- 自動テストの編集モデルはDiscord固有のイベント処理を再現しない。

## 14. 受信翻訳文の永続キャッシュ案（2026-10-05）

状態: 2026-10-05承認・実装済み。Node自動検証成功。実Chrome受け入れはユーザ確認で合格。
SPEC-EXT-001〜003とSPEC-QUEUE-001に本節の例外を適用する。
翻訳POSTの契機は既存の手動操作に限定する。
MUSTは必須、SHOULDは推奨、MAYは任意を表す。

### SPEC-CACHE-001 保存対象と識別

- MUST: 受信翻訳の`translate`要求だけを保存対象とする。
- MUST: 対象は既存selectorで検出した表示メッセージ本文とする。
- MUST: メッセージIDは既存の数値形式で検証する。
- MUST: 原文の識別には既存の翻訳先込みSHA-256を使う。
- MUST: 保存キーに版、メッセージID、原文識別hashを含める。
- MUST: 保存値は完成訳、版、保存時刻、失効時刻に限定する。
- MUST: 完成訳は既存の最終応答検証を通過した文字列とする。
- MUST: 保存開始時に受信要求の購読が有効な場合だけ保存する。
- MUST: `translateDraft`要求は永続キャッシュを読み書きしない。
- MUST: 原文、prompt、応答全体、途中訳、失敗結果は保存しない。

メモリキャッシュhitの受信翻訳も、対象IDに完成訳を保存する。
同文の別メッセージは、保存キーが異なるため自動復元しない。
共有jobの完了だけでは、解除済み受信要求の保存を行わない。
既存の返信プレビュー除外は維持する。

### SPEC-CACHE-002 寿命と削除

- MUST: 失効時刻は初回保存成功時刻から432,000,000ms後とする。
- MUST: `now < expiresAt`の場合だけ保存訳を有効とする。
- MUST: 有効期間内の再保存と復元では有効期限を延長しない。
- MUST: 期限切れの場合はキャッシュmissとして扱う。
- MUST: worker起動時と保存前に期限切れデータを削除する。
- MUST: 永続領域の保存失敗では有効な既存データを削除しない。
- MUST: キャッシュ削除で`enabled`設定を削除しない。

OFFは表示と購読を破棄するが、有効な保存訳は削除しない。
再度ONにした場合は期限内の保存訳を復元する。
worker停止、拡張機能再読込、Chrome再起動で保存訳を失わない。
拡張機能の削除やストレージの明示削除は保持対象外とする。
拡張機能が停止中の場合は、期限切れデータの物理削除を行えない。
5日間は復元可能な有効期間であり、厳密な時刻の物理削除ではない。
期限切れ後に手動翻訳した場合は、新しい5日間の保存を開始する。

### SPEC-CACHE-003 検索と表示

- MUST: ON中の初回検出と再描画で保存訳を検索する。
- MUST: 検索には`lookupTranslation`とID、trim済み本文を渡す。
- MUST: workerは既存sender境界と受信入力境界を検証する。
- MUST: 検索はqueue、bridge、翻訳APIへ進まない。
- MUST: 検索中は対象recordの重複検索を抑止する。
- MUST: hit時は既存の完成訳表示でブロックを1つ復元する。
- MUST: miss時は手動の`翻訳`ボタンを1つ表示する。
- MUST: 本文、ID、record、DOMの一致を検索完了時に確認する。
- MUST: OFFまたは一致しない場合は検索結果を破棄する。
- MUST: 本文変更やID変更の場合は新しい対象を検索する。
- MUST: 同じ対象の追加UIだけが失われた場合も表示を復元する。

content scriptは必要なID属性の変更も検出する。
復元したブロックは既存のラベル、改行、`lang="ja"`を維持する。
復元した本文は`textContent`で表示する。
検索中の押下は抑止し、検索完了後に手動翻訳を受け付ける。
検索の監督期限は5秒とし、超過を`cache_read_failed`としてコンソールへ記録する。
hit、miss、読込み失敗のいずれでも自動翻訳を開始しない。

### SPEC-CACHE-004 容量とエラー

保存先は既存権限で使用できる`chrome.storage.local`とする。
`storage.sync`とDiscordページの`localStorage`は使用しない。
Chromeの標準容量上限は10MBである。
根拠は[Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)を参照する。

- MUST: 容量不足と書込み失敗を`cache_write_failed`へ正規化する。
- MUST: 書込み失敗でも検証済み完成訳を画面に表示する。
- MUST: 書込み失敗時は「翻訳文を保存できませんでした」と表示する。
- MUST: 完成結果に保存状態を添え、保存成功と失敗を区別する。
- MUST: 自動検索の読込み失敗は固定コード`cache_read_failed`だけをコンソールへ記録し、Discord上に警告を表示しない。
- MUST: 読込み失敗後は手動の`翻訳`ボタンを表示する。
- MUST: 不正な保存値は表示せず、削除対象とする。
- MUST: 削除失敗は`cache_cleanup_failed`で通知する。
- MUST: 例外詳細、原文、訳文をログへ出力しない。

容量不足時は期限切れデータだけを削除し、保存を1回再試行する。
再試行に失敗した場合は、永続保存成功として扱わない。
自動の無限再試行、早期LRU削除、新しい権限は追加しない。
完成結果の保存処理は5秒で監督し、表示を無期限に待たせない。
復元時の期限判定は削除処理の成功に依存しない。

検索要求は`{type:"lookupTranslation",messageId,text}`とする。
検索応答は`{status:"hit",text,error}`か`{status:"miss",error}`とする。
正常検索では`error`を`null`とする。
受信完成結果は`{type:"result",text,cache:{saved,error}}`とする。
保存成功では`saved:true`と`error:null`を返す。
保存失敗では`saved:false`と`error:"cache_write_failed"`を返す。
削除失敗は保存成功時も`error:"cache_cleanup_failed"`で通知する。
投稿用の完成結果は既存の`{type:"result",text}`を維持する。

## 15. 翻訳ボタンのテーマ対応（2026-10-05）

状態: 2026-10-05承認・実装済み。ユーザの実機再確認で合格し、タスク完了。
MUSTは必須を表す。

### SPEC-THEME-001 表示テーマとボタンの状態

対応要求: REQ-F-033、REQ-F-034、REQ-N-014。

- MUST: 対象は「翻訳」「英語に翻訳」「再試行」「元に戻す」とする。
- MUST: 対象には「確認中…」「翻訳中…」の無効状態を含める。
- MUST: 背景、文字、境界線、focusの色はDiscordの表示テーマに従う。
- MUST: 表示テーマを変更した場合は、表示中のボタンへ配色を反映する。
- MUST: 配色の反映にページ再読込やボタン再生成を要求しない。
- MUST: 新しく表示するボタンにも現在の表示テーマを適用する。
- MUST: OSのテーマが異なる場合もDiscordの表示テーマを優先する。
- MUST: 有効なボタンの文字と背景のコントラスト比は4.5:1以上とする。
- MUST: 有効なボタンではhoverの配色とfocusの輪郭を表示する。
- MUST: disabled中はhoverによる有効状態の配色を適用しない。
- MUST: disabled中もラベルを表示し、既存の押下抑止を維持する。
- MUST: テーマ変更では翻訳要求、下書き変更、表示結果の削除を行わない。

拡張機能専用のテーマ設定と保存項目は追加しない。
ボタンのラベル、配置、クリックとキーボード操作は維持する。
popup、訳文ブロック、案内文の配色は変更対象外とする。

実機確認はユーザが行う。
初回の実機確認では、両テーマで全ボタンの視認性が不合格だった。
2026-10-05、ユーザは修正後の実機再確認で合格と報告した。
実機受け入れはユーザ報告により合格とし、タスク完了とする。
個別の操作状態の試験内訳とコントラストの実測値は未報告である。


## 16. ローカル / ChatGPT の選択 (2026-10-12)

状態: 完了。Node test 91件、Python self-check、JS構文とmanifest JSONの検証は成功。実 API と補助による固定文の日訳・英訳は成功。2026-10-12のユーザ実機動作確認により、本変更の実 Chrome 受け入れは合格。
本節は旧節の固定接続先、popup、権限、外部通信の条件を拡張する。
本節で変更しないローカルの契約は維持する。

### SPEC-PROVIDER-001 選択と有効化

- MUST: `chrome.storage.local` に `provider` を保存する。
- MUST: 未設定の provider は `local` とする。不正値は拒否する。
- MUST: popup にローカルと ChatGPT の選択を表示する。
- MUST: 選択変更時は OFF にして、利用者が改めて ON にする。
- MUST: local の ON は既存 MLX health を使用する。
- MUST: chatgpt の ON は補助の接続・利用許可・model を確認する。
- MUST: ChatGPT の本文送信、利用枠、利用量設定リンクを表示する。
- MUST: 接続は `Continue with ChatGPT`、切断は専用 button とする。
- MUST: 切断では OFF にする。遠隔失効が未確認の場合は案内を表示する。
- MUST: 失敗で自動的に別翻訳先や別の課金方法へ切り替えない。

### SPEC-PROVIDER-002 認証と保管

補助は `http://127.0.0.1:8766/auth/callback` で OAuth を受信する。
PKCE S256、state、nonce と10分の一回限り認証試行を使用する。
初回は dynamic registration を使い、issued client ID を保持する。
同じ接続の再認証は issued ID と検証済み subject を照合する。
ID token は OpenAI の discovery / JWKS と RS256 署名で検証する。
issuer、audience、expiration、issued-at、nonce、subject を検証する。
利用可否は token response の granted scopes で判定する。
access token は有効期限前に単一の refresh 処理で更新する。
更新 token 一式を atomic に置換する。
model は認証時の選択を保持し、refresh 時の別 API 障害で更新 token を失わない。
保存 directory は `~/.config/discord-translate`、権限は0700とする。
状態ファイルは0600で保存し、host ID と接続情報を保持する。
切断後も host ID と接続の client / subject 対応は保持する。
認証世代を照合し、古い callback / refresh の保存を拒否する。
切断では実行中の外部要求を中断し、tokens を削除する。
切断の削除保存は直後の再認証開始で取り消さず、後続保存との順序を保つ。
renewable session の失効失敗を成功扱いにしない。
本文、tokens、authorization URL、例外詳細はログへ出さない。

### SPEC-PROVIDER-003 補助の HTTP と推論

起動は `CORS_ORIGIN=chrome-extension://<ID> node scripts/chatgpt-server.mjs`。
Node.js 22 以上の標準機能を使い、追加 package は導入しない。
listener と callback は固定の `127.0.0.1:8766` とする。
Host は listener と一致させる。CORS は指定拡張 origin だけを許可する。
通常 API は `X-Discord-Translate: 1` を要求する。
Origin がある場合は完全一致を要求し、`null` を拒否する。
Origin がない独自 header 付き要求は同機プロセスとして扱う。
login / callback GET は認証試行で認可し、他のページ操作を認めない。

| 経路 | 動作 |
| --- | --- |
| `GET /status` | tokens を含まない接続状態と使用 model を返す。 |
| `POST /auth/start` | 認証試行を生成し、loopback login URL だけを返す。 |
| `GET /auth/login` | 試行を照合し、OpenAI の認証へ redirect する。 |
| `GET /auth/callback` | code を交換・検証し、固定メッセージを返す。 |
| `POST /auth/logout` | session 失効を試み、tokens を削除する。 |
| `POST /v1/chat/completions` | 固定翻訳 payload を Responses API へ変換する。 |

推論は公開 `https://api.openai.com/v1/responses` だけを使用する。
`instructions` と user input を渡し、`store:false`、`stream:true` とする。
ローカルの sampling / token 設定を OpenAI へ転送しない。
利用可能なモデル一覧の先頭の表示対象 model を使う。
受け付ける prompt は既存の日本語 / 英語の固定翻訳 prompt だけとする。
本文は8000 UTF-16コード単位、累積訳は64KiBを上限とする。
要求 body は64KiB、SSE event は1MiBを上限とする。
全推論と bridge の timeout は120秒とする。
`response.completed`、内部 completed status、出力と usage を検証する。
最終 output が空配列の場合だけ、先に受信した単一の完成済み
`response.output_item.done.item` を使う。ID / index と累積 delta の一致、
assistant / completed / 単一 output_text を検証する。
最終 output が非空の場合の照合は維持する。item 完了だけでは成功にしない。
上流 Content-Type の欠落は許容するが、明示的な非 SSE 型は拒否する。
欠落時も SSE 構文、出力と最終完了を検証し、bridge へ SSE 型を付けて返す。
EOF、failed、incomplete、refusal、tool 出力は失敗とする。
変換後は既存 choices / usage / `[DONE]` の SSE 契約を使用する。
401/403 は再接続、429 は利用量設定の確認を案内する固定 code とする。

### SPEC-PROVIDER-004 job、cache、切替

worker は要求受付時の provider を job と保存処理へ固定する。
Content から任意の provider / endpoint を受け付けない。
job と memory cache の key は provider を区別する。
local の旧 hash と保存 key は維持し、旧受信訳を利用できる。
chatgpt の hash に provider を加え、local と共有しない。
保存期限、容量失敗、投稿訳の非保存は維持する。
選択変更時は既存の OFF lifecycle で表示と購読を破棄する。
下書き本文を変更せず、再 ON で選択先の保存訳を検索する。
切替前に受付済みの job は元の provider を保持する。
共有 job の個別購読解除契約は変更しない。
切断済み bridge と画面へ古い結果を適用しない。

Manifest は `http://127.0.0.1:8766/*` を追加する。
外部 OpenAI origin の host permission と新しい API permission は追加しない。
popup の認証操作で本文を送信しない。
Chrome storage に provider と既存データを保存し、tokens は保存しない。

#### 2026-10-12 実 API の応答形式と修正検証

認証後の `http_error` を調査した。公開 Responses API は HTTP 200 の
SSE を返したが Content-Type がなく、最終 `response.completed` の
output は空配列だった。完成 message は `response.output_item.done` にあり、
usage は最終 event に含まれていた。旧補助は header の必須検査で502を返し、
header の条件だけを外しても旧 converter は空 output を拒否する。
`store:false` が原因と断定せず、観測した応答への限定互換処理とする。
固定 fixture で旧 converter の失敗を再現し、上記検証条件を維持して修正した。
Node test 91件成功。修正済み補助を一時 loopback port で実行し、既存の
実アカウントによる固定文の日訳・英訳で HTTP 200、正常 completed、usage、
bridge 用 SSE と `[DONE]` を確認した。本文・訳文・tokens は出力していない。
エージェントは稼働中の補助プロセスの置換と実 Chrome の操作を行っていない。
その後、2026-10-12にユーザが実機での動作確認成功と完了を報告した。
この報告に基づき本変更の実 Chrome 受け入れを合格とし、タスクを完了する。
個別の操作・異常系の試験内訳、利用枠上限と長文品質の実機検証は未確認である。

### SPEC-PROVIDER-005 Native Messaging による自動起動（2026-10-13）

2026-10-14の翻訳先別起動と停止条件は SPEC-PROVIDER-006 を優先する。以下の完了記録は2026-10-13の変更だけを対象とする。

状態: 完了。ユーザが Native Messaging 方式を選択し、実装・Node 自動検証済み。2026-10-13のユーザ実機確認により本変更の受け入れは合格し、ユーザの指定により開発を完了した。
SPEC-PROVIDER-004 の API permission 非追加条件に `nativeMessaging` の例外を設ける。
macOS Chrome のユーザ用 host 登録を一度行い、登録した拡張 ID だけが起動できる。
拡張 worker 読み込みと Chrome プロファイル起動時に既存 ChatGPT 補助を起動する。
ON / OFF、翻訳先とアカウントの接続状態に関係なく、Native 接続中は補助を維持する。
Native 接続終了・拡張無効化・Chrome 完全終了時は進行中の要求と HTTP 接続を停止する。
起動完了を15秒以内に確認し、完了前に popup の ChatGPT HTTP と worker の ChatGPT 翻訳を実行しない。
失敗時は有効化を認めず、登録と固定ポート競合の確認を案内する。次の操作で再試行する。
無限再起動、競合プロセスの停止、既存サーバの引き継ぎは行わない。
補助を起動するだけでは自動翻訳・本文送信を行わない。Native 経路へ本文・認証情報を渡さない。
初回登録・解除・再登録の手順は README の ChatGPT セットアップを参照する。

## 17. サプライチェーン対策 (2026-10-14)

本節の要求レベルは MUST とする。
判断は [ADR-011](../adr/011-verified-dependency-and-model-inputs.md) に従う。

### SPEC-SUPPLY-001 依存導入

`scripts/setup_local.py` は新規 venv だけに導入する。
対象は macOS 26+ / arm64 / CPython 3.14 とする。
`--python-source` は運用者が確認した Python の取得元を受け取る。
既存 venv と空の取得元は拒否する。

`requirements.txt` は `name==version --hash=sha256:...` だけを許可する。
追加 index、URL、別の要件ファイル、未固定依存は受け付けない。
導入処理は `PIP_*` と `PYTHON*` 環境変数を子プロセスから除く。
導入処理は `PIP_CONFIG_FILE` に `os.devnull` を設定する。
pip の通常設定による追加配布元を遮断する。
pip は `--require-hashes --only-binary=:all:` で導入する。
pip の index は `https://pypi.org/simple` に固定する。
導入失敗時は代替手段へ切り替えず、非ゼロで終了する。
導入成功後は `pip check` を行う。
導入記録は venv 内の `supply-chain-install.json` に保存する。
記録は commit、dirty 状態、依存台帳 hash、Python と pip の由来を含む。

### SPEC-SUPPLY-002 モデル取得と起動

`models.lock.json` の schema version は 1 とする。
台帳は default model とモデル別の commit・ファイル情報を持つ。
ファイル情報は名前、サイズ、SHA-256 に限定する。
許可するファイル形式は JSON、Jinja template、safetensors とする。
現在の登録モデルは Qwen3.5-9B の固定 commit 1件とする。

`scripts/model_assets.py fetch` は台帳のファイルだけを取得する。
取得元は `https://huggingface.co` の固定 commit とする。
取得に認証 token は使用しない。
`--from-cache` は指定した snapshot から対象ファイルをコピーする。
取得処理は一時領域の全ファイルを検証後、配置を確定する。
既存の配置は上書きせず、再検証する。

`verify` はネットワークと外部 Python package を使用しない。
起動時は `verify` の成功後だけ公式 MLX CLI を実行する。
検証は台帳未登録、余分なファイル、不足、サイズ・hash 不一致を拒否する。
検証は不正なファイル名とモデル領域外への symlink を拒否する。
検証は config と tokenizer config の動的コード指定を拒否する。
対象は `model_file`、`auto_map`、`custom_pipelines` とする。
組込み `qwen3_5` と `TokenizersBackend` だけを許可する。
custom な `chat_template_type` と `tool_parser_type` は拒否する。
検証失敗時は固定エラーを標準エラーへ出し、exit code 2 とする。

CLI は `trust_remote_code` に None を渡す。
フラグ省略を明示的な False の設定とは扱わない。
固定データと組込み実装への限定でモデル由来のコード参照を閉じる。
標準入力は `/dev/null` とし、対話による許可を行わない。
公式サーバの API は変更しない。
同一端末の任意クライアントによるモデル切替は保護範囲外である。
拡張の既存 payload は任意モデルや adapter を受け付けない。

### SPEC-SUPPLY-003 拡張機能の実行境界

Manifest V3 と既存の権限を維持する。
Extension pages の CSP は次のとおりとする。

```text
script-src 'self'; object-src 'none';
connect-src http://127.0.0.1:8080 http://127.0.0.1:8766;
```

CSP は同梱 iframe、popup、worker に適用する。
CSP は Native host と Discord 本体には適用しない。
認証画面への navigation と外部 API fetch は区別する。
package.json の ESM 設定は維持する。
外部 npm 依存の追加は方針検査で検出する。
両翻訳先と既存の要求・保存・認証の境界は維持する。

### SPEC-SUPPLY-004 更新と検証の境界

更新時は公式の配布元、保守状況、非推奨情報、公開勧告を確認する。
更新時は全依存とモデル台帳の差分をレビューする。
通常起動に更新処理を追加しない。
導入、異常系、両翻訳先、CSP の回帰を検証してから採用する。
実 Chrome、実モデル、実 API と自動テストの結果は分けて記録する。
未知の悪意、配布元の侵害、parser の欠陥がないとは保証しない。

2026-10-14、ユーザが動作確認の完了を報告した。
今回の実 Chrome 受け入れを合格とし、開発を完了する。
個別操作と異常系の実機試験内訳は未報告である。


## 18. 選択した翻訳先の自動起動 (2026-10-14)

### SPEC-PROVIDER-006 起動先の選択と停止

- MUST: 保存済み provider の固定 Native host だけを起動する。local は `com.discord_translate.local`、ChatGPT は既存の `com.discord_translate.chatgpt` とする。
- MUST: 拡張 worker 読み込み・Chrome プロファイル起動・provider 変更に対応する。provider 変更で旧接続を閉じる。遅れた設定読取りは新しい選択を上書きしない。
- MUST: local は固定モデルとポート8080、caller origin の CORS で `scripts/start-server.sh` を使う。モデル取得や依存導入を起動処理へ追加しない。
- MUST: local の ready は120秒以内に、子プロセスの listener 所有と `/health` の厳密な正常応答を確認して通知する。Native 待機の上限は local 130秒、ChatGPT 15秒とする。
- MUST: popup の起動要求は同じ拡張 ID・正確な popup URL・tab なし・保存済み provider 一致を条件とする。Native 経路の受信データは引き続き拒否する。
- MUST: 有効化時のブラウザ health と両翻訳先への要求は ready を待つ。local 起動失敗は `local_unavailable` とし、有効化しない。Chrome の LNA 確認は維持する。
- MUST: OFF とアカウント切断では停止しない。切替・EOF・signal・拡張無効化・Chrome 完全終了では自分のサーバを停止する。local のモデル検証中もプロセスグループを停止する。
- MUST: local は SIGTERM 後1秒で終了しなければ SIGKILL を送る。ready 後の子プロセス終了でも Native 接続を閉じる。
- MUST: 競合サーバを引継ぎ・停止しない。失敗時は次の操作で再試行し、無限再起動や翻訳先の自動変更を行わない。

macOS 標準 `/usr/sbin/lsof` で listener の所有を確認する。登録は既存 installer で両方を行い、既存利用者も再登録する。権限と依存は追加しない。
実 Chrome と自動検証の結果は [実装計画](../plans/active/2026-10-14-provider-server-startup.md) に分けて記録する。

2026-10-14、ユーザの実機確認完了報告に基づき、本変更の実 Chrome 受け入れを合格とし、完了した。個別操作と異常系の実機試験内訳は未報告である。

## 19. Node.js 更新に追従する起動 (2026-10-22)

### SPEC-PROVIDER-007 起動時の Node.js 選択

- MUST: nvm 管理下の登録では、起動時に対応 Node.js を選択する。
- MUST: 登録した管理ルート内の実行可能な候補だけを調べる。
- MUST: 24 以上で `process.release.lts` を持つ候補を対象とする。
- MUST: major、minor、patch の数値順で最新版を選択する。
- MUST: 旧版削除後も、残った対応版で再登録せずに起動する。
- MUST: default と LTS alias の未設定・参照切れに依存しない。
- MUST: npm、Chrome の PATH、シェル初期化ファイルに依存しない。
- MUST: Node.js の取得、alias 更新、他の導入元の探索を行わない。
- MUST: 実行不能な候補は診断を残し、対象から外す。
- MUST: 対応版がなければ stderr で通知し、非ゼロで終了する。
- MUST: 診断や候補確認の出力を Native stdout に混ぜない。
- MUST: Chrome の引数と入力を Native host に引き継ぐ。
- MUST: SPEC-PROVIDER-006 の ready 待機と停止の契約を維持する。

nvm 管理外は登録時の Node.js の絶対パスを使う。
新方式への移行時は、既存 installer で一度登録を更新する。
リポジトリ、nvm の管理ルート、拡張 ID の変更は再登録を要する。
サポート中 LTS の導入は利用環境の要件として維持する。
LTS 属性だけでは EOL を判定できないため、自動判定は行わない。
Node test 112 件は成功した。
2026-10-22、ユーザの動作確認報告により実 Chrome の受け入れは合格。
個別操作と実環境の旧版削除による試験内訳は未報告である。
記録は [実装計画](../plans/active/2026-10-22-native-host-node-resolution.md) を参照する。

## 20. ポップアップの表示 (2026-10-22)

### SPEC-POPUP-001 情報と操作の配置

対応要求: REQ-POPUP-001〜005。
2026-10-22、ユーザは見出しと短い操作説明の追加を承認した。
状態: 完了。幅崩れ修正後の実 Chrome 受け入れはユーザ報告で合格。

- MUST: `Discord Translator` を本文の見出しとして表示する。
- MUST: 翻訳先 select、ChatGPT 接続、有効化の順に配置する。
- MUST: ChatGPT 接続領域は、ChatGPT 選択時だけ表示する。
- MUST: 本文送信と利用枠の説明を、接続ボタンより前に置く。
- MUST: 接続アカウント、モデル、状態確認、切断、利用量リンクを維持する。
- MUST: 接続ボタンの `Continue with ChatGPT` を維持する。
- MUST: checkbox は `Discord Translator を有効にする` と表示する。
- MUST: 有効化で翻訳ボタンが表示されることを説明する。
- MUST: 翻訳はボタンを押したときに実行することを説明する。
- MUST: 有効・無効、処理中、失敗と固定コードを文字で表示する。
- MUST: 見出し下線、select の枠、有効化領域の左線に青紫を使う。
- MUST: 明色・暗色、キーボード操作と状態通知を維持する。
- MUST: 長い状態文と識別子を折り返し、操作の重なりを防ぐ。

幅は余白込み 360px とし、小さい初期 viewport の幅へ縮めない。
内容から popup の幅を決めるため、viewport 相対の上限を付けない。
状態文で高さが増えた場合も、内容を省略しない。
操作中は既存の disabled を維持し、focus の輪郭を表示する。
有効化の条件、通信、認証、Native 起動の仕様は変更しない。
SPEC-PROVIDER-001 と SPEC-PROVIDER-006 の状態遷移を維持する。
検証結果は [実装計画](../plans/active/2026-10-22-popup-layout.md) に記録する。
