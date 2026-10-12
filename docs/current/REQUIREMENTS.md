# 要件定義書

2026-10-02に順次表示を承認・実装した。追加要求は第7節を参照する。自動・実モデル検証は成功、実ChromeもユーザーのTask 5実機確認により合格し、本変更は完了した。

- Status: Current
- Last reviewed: 2026-10-12
- Approved addition: 第8節は実装・自動/実モデル検証済み。実Chrome受け入れはユーザ確認で合格。
- Theme addition: 第10節は完了。実機受け入れはユーザの再確認で合格。
- Product: Discord ローカル日本語翻訳

## 1. 目的と読み方

本書は、1台の Apple Silicon Mac 上で動かす個人用 Discord Web 翻訳システムの現在有効な要求を定義する。外部動作の詳細は [SPECIFICATIONS.md](SPECIFICATIONS.md)、責務配置は [DESIGN.md](DESIGN.md)、製品目的は [PRD.md](PRD.md)、完了した実装履歴は [実行計画](../plans/completed/2026-08-18-local-discord-translator.md) を参照する。

状態は次の意味で使う。

- `実装済み`: リポジトリに対応実装がある。
- `未実装`: 要求は有効だが対応実装がない。
- `一部実装`: 要求の一部だけに対応実装がある。
- `未検証`: 実装はある、または設計上想定しているが、必要な実機検証が完了していない。

## 2. 機能要求

| ID | 要求 | 現在状態 |
| --- | --- | --- |
| REQ-F-001 | ON中の現在表示中・新規Discordメッセージごとに`翻訳`ボタンを1つ表示し、そのボタンを押したメッセージだけを自然な日本語へ翻訳できること。DOM検出やボタン生成だけでは翻訳を依頼しないこと。 | 実装済み・Node test合格・実Chrome動作確認済み。 |
| REQ-F-002 | 翻訳 API は `POST /v1/chat/completions` を受け付け、SSEの `choices[0].delta.content` を順次取得し、正常終了・usage・終端を検証して確定できること。 | 実装済み・実機検証済み。 |
| REQ-F-003 | 翻訳結果だけを返し、解説、原文の反復、thinking/reasoning を表示しないこと。 | 実装済み。固定ケースでは検証済み。 |
| REQ-F-004 | URL、Markdown、ユーザー名、`@username`、`#channel`、コード、インラインコード、製品名、API名、ライブラリ名、識別子、絵文字を意味上必要な範囲で保持すること。 | 一部検証済み。実ID検証ではdaily/discord/code/japanese/prompt/serialが成功し、Markdown/URL caseの`**the patch**`不変条件が未合格。スラングと長い複数文の目視品質も未検証。 |
| REQ-F-005 | 日本語入力でも異常な出力をせず、意味を変えないこと。 | 固定1ケースのみ検証済み。 |
| REQ-F-006 | Qwen の MLX 4bit 量子化モデルを使い、モデルを環境変数 `MODEL` で変更できること。 | 実装済み。Qwen3-8B-4bit だけ実機検証済み。 |
| REQ-F-007 | `./scripts/start-server.sh` で起動し、フォアグラウンドでは `Ctrl-C` で停止できること。 | 実装済み・実機検証済み。 |
| REQ-F-008 | 既存の `/health` で HTTP サーバ状態を確認し、実 chat completion で model readiness を確認できること。 | 実装済み・実機検証済み。 |
| REQ-F-009 | Chrome content scriptは利用者の`翻訳`または`再試行`押下時だけservice workerへ翻訳を依頼し、service workerがsender/input、固定payload、queue/cache、最終応答を所有すること。localhostへの翻訳HTTP送信だけは、同じDiscord tab内の検証済みExtension document bridgeへ委譲すること。popupはLNA許可取得用の`/health`確認だけを行える。 | 実装済み・Node test合格・実Chrome検証済み。 |
| REQ-F-010 | Chrome Extension 側が受け付け順の有限 queue を所有し、初期同時実行数を1にすること。 | 実装済み。concurrency 1、最大64 unique job、queue待機120秒をNode testで検証済み。 |
| REQ-F-011 | Chrome Extension 側で翻訳キャッシュを所有し、サーバ側には初期段階でキャッシュを追加しないこと。 | 実装済み。memory cache 256件・30分と受信完成訳の5日間保存をNode testで検証済み。受信保存の実Chrome受け入れはユーザ確認で合格。サーバ側 cache は追加していない。 |
| REQ-F-012 | 押下後は`翻訳中…`として重複押下を抑止すること。bridge fetchとservice worker job監督は120秒の有限timeoutで一致させ、超過時は`request_timeout`とすること。生成中から原文直下の訳文を更新し、成功時に確定し、失敗時は部分訳を除去して原文を残してservice workerの固定error codeと`再試行`を表示すること。本文変更・DOM差し替え時は古い結果を破棄し、新本文用の`翻訳`へ戻すこと。 | 実装・Node test済み。旧方式は実Chrome確認済み。順次表示もTask 5で合格（2026-10-02ユーザー報告）。 |
| REQ-F-013 | 基本機能と結合検証が完了した後、macOS ログイン時に `launchd` で自動起動できること。 | 未実装。 |
| REQ-F-014 | popupでOFFからONへ切り替えるとき、Extension documentから固定`/health`へ接続してChromeのLocal Network Access許可を取得し、health成功時だけ`enabled=true`へ遷移すること。 | 実装済み・Node test合格・実Chrome正常系/異常系検証済み。 |
| REQ-F-015 | ON中の各Discord top tabにExtension package内の非表示bridgeを1個だけ置き、既定翻訳経路は検証済みPort経由の固定payloadだけを固定localhost APIへ送ること。bridgeはpage message、任意URL、任意payloadを受理せず、OFF・tab unloadで破棄されること。 | 実装済み・Node test合格・実Chrome動作確認済み。 |

## 3. 非機能要求

| ID | 要求 | 現在状態 |
| --- | --- | --- |
| REQ-N-001 | Discord 本文を外部 LLM API、翻訳 API、telemetry、analytics へ送らないこと。 | サーバ単体は offline 起動し、確認時に外部 TCP 接続なし。Extension を含む全経路は未検証。 |
| REQ-N-002 | API は IPv4 loopback `127.0.0.1` だけで listen し、LAN・インターネットへ公開しないこと。 | loopback listener は確認済み。LAN 別端末からの拒否は未検証。 |
| REQ-N-003 | CORS は実際の `chrome-extension://<EXTENSION_ID>` だけを許可し、`*` や Discord page origin を許可しないこと。 | 実IDのpreflight、`/health`、実Chrome bridge fetch、disallowed originを検証済み。 |
| REQ-N-004 | 通常ログに request body、prompt、response、翻訳本文を保存しないこと。 | CRITICAL 設定と通常要求で本文非出力を確認済み。不正JSONを含むprivacy marker試験は未実施。 |
| REQ-N-005 | 通常運用ではモデルを事前 cache し、`HF_HUB_OFFLINE=1` と telemetry 無効で起動すること。 | 実装済み・offline再起動確認済み。 |
| REQ-N-006 | システム Python を汚さず、プロジェクトの `.venv` と最小依存で動作すること。 | 実装済み。`mlx-lm==0.31.3` を固定。 |
| REQ-N-007 | 大量並列より安定性を優先し、サーバの prompt/decode concurrency と Extension queue を初期値1にすること。 | サーバ/Extensionとも実装済み。Node queue test合格。 |
| REQ-N-008 | 連続要求で結果を混線させず、メモリが無制限に増加しないこと。 | 20件直列は成功。100件後のメモリ推移は未検証。 |
| REQ-N-009 | メッセージ単位の翻訳用途では最大品質より、翻訳品質を保てる短文レイテンシとメモリ効率を優先すること。 | Qwen3-8B-4bit で基準値を取得済み。比較モデルと合否閾値は未決定。 |
| REQ-N-010 | Chrome の現行 Local Network Access、CORS、権限UIの下で、localhost以外へ権限を広げず動作すること。service workerはLNA promptを表示できないため、popup documentの固定health GETで事前許可を取得すること。 | 最小Manifest権限、実ID CORS preflight、実Chromeのpopup healthと翻訳動作、sender URL検証hotfixのNode testを確認済み。 |
| REQ-N-011 | model load time、first request latency、subsequent request latency、tokens/sec、memory usageを同一条件で測定し、翻訳品質と合わせてmodelを評価できること。 | 単体generate速度・peak memoryとserver平均latency/RSSは取得済み。model load、first/warmの分離、比較modelは未測定。 |

## 4. 制約

| ID | 制約 |
| --- | --- |
| CON-001 | 対象は macOS、Apple Silicon、native arm64 Python、MLX、`mlx-lm`、Qwen MLX量子化モデルである。 |
| CON-002 | 初期モデルは `mlx-community/Qwen3-8B-4bit`。Qwen3.5採用は比較検証なしに確定しない。 |
| CON-003 | 独自推論サーバ、FastAPI、Flask、新しい Web framework は、公式 `mlx_lm.server` で満たせない実測上の必要が出るまで追加しない。 |
| CON-004 | APIは`stream=true`とし、製品固有のserver-side訳文cache、speculative decoding、複数モデル同時常駐を追加しない。 |
| CON-005 | CORS は認証ではなく、同一Mac上の別プロセスを排除する境界とは扱わない。 |
| CON-006 | `launchd` はChrome Extensionを含む基本機能と結合検証の完了後に実装する。 |
| CON-007 | 未確認のChrome挙動、翻訳品質、モデル安定性を完了済みと表現しない。 |
| CON-008 | bridge方式でも`web_accessible_resources`は`bridge.html`とDiscord originだけに限定し、`externally_connectable`、`offscreen` permission、Discord originのCORS許可、Chrome security無効化を追加しない。 |

## 5. 受け入れ条件と追跡

| ID | 受け入れ条件 | 対応要求 | 対応仕様 | 現在結果 |
| --- | --- | --- | --- | --- |
| AC-001 | popupで有効化すると現在表示中と新規の各Discordメッセージに`翻訳`ボタンが1つ表示され、走査・DOM検出・ボタン生成だけでは翻訳用Port要求も翻訳POSTも発生しない。ボタン1回の押下につき1要求Portとなり、`翻訳中…`では連打を抑止し、生成中から原文直下へ部分訳を表示し、成功時に確定し、失敗時は部分訳を除去して固定codeと`再試行`を表示する。OFFでは挿入UIを除去してPOSTせず、本文変更・DOM差し替え後の古い結果は破棄して新本文用の`翻訳`へ戻す。 | REQ-F-001, REQ-F-009, REQ-F-012 | SPEC-EXT-001〜003 | 順次表示のNode test合格。旧方式の実Chrome確認済み。新方式もTask 5で合格（2026-10-02ユーザー報告） |
| AC-002 | APIが英語短文を日本語へ変換し、翻訳結果だけを返す。 | REQ-F-002, REQ-F-003 | SPEC-API-001, SPEC-API-003 | 合格（固定ケース） |
| AC-003 | URL、Markdown、コード、Discord識別子、絵文字を固定ケースで保持する。 | REQ-F-004 | SPEC-TR-001 | 実ID検証でdaily/discord/code/japanese/prompt/serialは成功。Markdown/URLの`**the patch**`不変条件は未合格 |
| AC-004 | thinking/reasoning、空応答、truncation、schema不正を成功扱いにしない。SHA-256失敗は`hash_error`、fetchの`NotAllowedError`/`SecurityError`は`lna_denied`、120秒timeoutは`request_timeout`、その他fetch拒否と未知値は`network_error`になり、本文・URL・`error.message`を露出しない。 | REQ-F-003, REQ-F-012 | SPEC-API-003, SPEC-EXT-003, SPEC-ERR-001 | streamingのNode test合格。旧方式の実Chrome境界検証合格。新方式のTask 5実機確認も合格（2026-10-02ユーザー報告） |
| AC-005 | listenerが `127.0.0.1` のみで、LAN別端末から接続できない。 | REQ-N-002 | SPEC-SEC-001 | listener合格、LAN拒否未検証 |
| AC-006 | 実Extension originのみCORS許可され、Discord originは許可されない。 | REQ-N-003, REQ-N-010 | SPEC-SEC-002, SPEC-EXT-004 | 実IDの`/health`、CORS preflight、実Chrome翻訳動作、disallowed originを検証済み |
| AC-007 | cache済みモデルでoffline起動し、翻訳中にloopback以外のTCP接続がない。 | REQ-N-001, REQ-N-005 | SPEC-SEC-003 | サーバ単体で合格。Extension全経路未検証 |
| AC-008 | 通常ログとエラー経路に固定privacy markerが残らない。 | REQ-N-004 | SPEC-LOG-001 | 通常要求のみ確認。不正JSON marker未検証 |
| AC-009 | Extensionの64件以下のburstをconcurrency 1で処理し、重複jobを1要求へまとめ、100件後もRSSが無制限に増え続けない。 | REQ-N-007, REQ-N-008 | SPEC-QUEUE-001 | Nodeでqueue順序、dedupe、limit、timeoutを合格。100件RSSと実UIは未検証 |
| AC-010 | 基本機能完了後、ログイン時にloopback/offline条件を保って自動起動・明示停止できる。 | REQ-F-013 | SPEC-OS-001 | 未実装 |
| AC-011 | model load、first/warm latency、tokens/sec、RSSを同一条件で記録し、固定翻訳ケースと合わせて採用modelを説明できる。 | REQ-N-009, REQ-N-011 | SPEC-PERF-001 | 一部測定済み。load・first/warm分離・比較modelは未測定 |
| AC-012 | 日本語、スラング、複数文、技術Discord文を目視し、意味保持と自然さを確認する。 | REQ-F-004, REQ-F-005 | SPEC-TR-001 | 日本語固定1ケースと実IDの一部固定caseは成功。Markdown/URL条件は未合格、目視品質は未検証 |
| AC-013 | 新規project-local venvへ固定依存を導入し、modelを環境変数で選び、1コマンド起動、health/readiness、停止、再起動が成功する。 | REQ-F-006, REQ-F-007, REQ-F-008, REQ-N-006 | SPEC-SRV-001, SPEC-SRV-002, SPEC-API-004 | Qwen3-8B-4bitで合格 |
| AC-014 | Extensionが30分・最大256件のmemory cacheを所有し、同一正規化本文の重複要求をserverへ再送せず、原文と投稿用の訳文を永続保存せず、server側に製品cacheを追加しない。受信完成訳だけはSPEC-CACHE-001〜004で5日間保存する。 | REQ-F-011 | SPEC-QUEUE-001 | Node自動検証合格。受信保存の実Chrome受け入れはユーザ確認で合格。 |
| AC-015 | OFF→ON時はpopupが接続確認中となり、LNA許可後の`GET http://127.0.0.1:8080/health`が5秒以内にHTTP 200かつ厳密な`{"status":"ok"}`を返した場合だけONになる。拒否・timeout・network・HTTP・schema失敗ではOFFを維持して固定codeを表示し、ON→OFFはhealthなしで即時反映する。 | REQ-F-014, REQ-N-010 | SPEC-EXT-001, SPEC-EXT-004 | popup・Node test・実Chrome health/翻訳/error code検証合格 |
| AC-016 | 正規Discord top tabの検証済みbridgeだけがservice worker構築payloadを固定APIへ送信し、serverでbrowser由来`POST`を観測できる。既定経路はservice workerのglobal fetchを呼ばない。別tab、別URL、top frame、重複Port、不正envelope、page messageではfetchせず、OFF・unload・disconnectは固定errorで終了する。 | REQ-F-009, REQ-F-015, REQ-N-001, REQ-N-003, REQ-N-010 | SPEC-EXT-003〜005, SPEC-SEC-002 | 既定bridge配線とglobal fetch不使用を含むNode test合格・実Chrome動作確認済み |

Phase 5.6実装前の実Chrome UIでは一部messageが成功し、一部が`request_timeout`となり、server側で応答write時の`BrokenPipeError`を確認した。当時の既定経路は設計済みbridgeではなくservice worker direct fetchで、両実装のtimeoutも25秒だった。Phase 5.6でbridge配線を復旧して両監督を120秒へ揃え、対象test 22件とExtension全体35件が合格し、実装後の実Chromeで翻訳動作を確認した。利用者の確認により、手動翻訳変更とbridge是正を完了とする。

## 6. 要求トレーサビリティ

| 要求ID | 仕様 | 受け入れ条件 |
| --- | --- | --- |
| REQ-F-001 | SPEC-EXT-001, EXT-002 | AC-001 |
| REQ-F-002 | SPEC-API-001, API-003 | AC-002 |
| REQ-F-003 | SPEC-API-002, API-003, API-004 | AC-002, AC-004 |
| REQ-F-004 | SPEC-TR-001 | AC-003, AC-012 |
| REQ-F-005 | SPEC-TR-001 | AC-012 |
| REQ-F-006 | SPEC-SRV-001, SRV-002, PERF-001 | AC-011, AC-013 |
| REQ-F-007 | SPEC-SRV-001, SRV-002 | AC-013 |
| REQ-F-008 | SPEC-API-004 | AC-013 |
| REQ-F-009 | SPEC-EXT-003 | AC-001 |
| REQ-F-010 | SPEC-QUEUE-001 | AC-009 |
| REQ-F-011 | SPEC-QUEUE-001 | AC-014 |
| REQ-F-012 | SPEC-EXT-001, EXT-003, ERR-001, ERR-002 | AC-004 |
| REQ-F-013 | SPEC-OS-001 | AC-010 |
| REQ-F-014 | SPEC-EXT-001, EXT-004 | AC-015 |
| REQ-F-015 | SPEC-EXT-003, EXT-004, EXT-005 | AC-016 |
| REQ-N-001 | SPEC-SEC-003 | AC-007 |
| REQ-N-002 | SPEC-SEC-001 | AC-005 |
| REQ-N-003 | SPEC-EXT-004, SEC-002 | AC-006 |
| REQ-N-004 | SPEC-LOG-001 | AC-008 |
| REQ-N-005 | SPEC-SRV-002, SEC-003 | AC-007 |
| REQ-N-006 | SPEC-SRV-001 | AC-013 |
| REQ-N-007 | SPEC-SRV-002, QUEUE-001 | AC-009 |
| REQ-N-008 | SPEC-QUEUE-001 | AC-009 |
| REQ-N-009 | SPEC-PERF-001 | AC-011 |
| REQ-N-010 | SPEC-EXT-004, SEC-002 | AC-006, AC-015 |
| REQ-N-011 | SPEC-PERF-001 | AC-011 |

## 7. 訳文の順次表示の追加要求（2026-10-02）

| ID | 追加要求 | 状態 |
| --- | --- | --- |
| REQ-F-016 | 手動翻訳の生成中に訳文を順次表示し、生成中と確定済みを区別すること。途中失敗時は部分訳を除去して固定 error と再試行を表示すること。 | 承認・実装済み。Node/実モデル確認済み。Task 5実Chrome確認合格（2026-10-02ユーザー報告） |
| REQ-F-017 | 現在のモデルと公式 MLX-LM のメモリ内入力 KV cache を維持し、異なる原文間でも共通入力 prefix を再利用すること。無効・未再利用を実測した場合だけ、原因に対応する最小変更を提案すること。 | 既存構成で再利用確認済み。追加変更不要 |

| 受け入れ条件 | 観測可能な条件 | 追跡 | 状態 |
| --- | --- | --- | --- |
| AC-017 | 最初の非空 content が生成完了前に表示され、同じブロックで更新される。正常な終了・usage・stream 終端を検証した場合だけ確定して cache へ保存する。失敗、reasoning、truncation、OFF、本文編集、DOM 交換で部分訳を残さず、重複要求でも POST は1回である。 | REQ-F-016、SPEC-STREAM-001〜003 | Node/実モデルで合格。Task 5実Chrome確認も合格（2026-10-02ユーザー報告） |
| AC-018 | 同じ system prompt と生成設定で異なる固定非機密英文を送信し、後続要求の `usage.prompt_tokens_details.cached_tokens > 0` を確認する。本文・訳文を出力・保存しない。 | REQ-F-017、SPEC-KV-001 | 非streamingで66 token、移行後のstreaming後続7件で66〜68 tokenを確認。起動設定変更なし |

REQ-F-002、REQ-F-012、CON-004、AC-001を承認済み新仕様へ同期した。REQ-F-011/AC-014のserver側cache禁止は製品固有の訳文cacheを指し、既存の入力KV cacheは含めない。セキュリティ、privacy、有限queue/timeoutの要求は維持する。

## 8. 投稿前の英語翻訳の追加要求案（2026-10-05）

状態: 2026-10-05承認・実装済み。実Chrome受け入れはユーザ確認で合格した。
英語訳の下書き反映、編集継続、「元に戻す」はユーザ指定で確定した。
本節は既存機能の承認状態を変更しない。
MUSTは必須、SHOULDは推奨、MAYは任意を表す。

| ID | レベル | 追加要求 |
| --- | --- | --- |
| REQ-F-018 | MUST | ON中は対象の投稿入力欄に「英語に翻訳」を1つ表示する。 |
| REQ-F-019 | MUST | ボタン押下時だけ、日本語の下書きを英語へ翻訳する。 |
| REQ-F-020 | MUST | 正常終了後、同じ入力欄の下書きを完成した英語訳へ置き換える。 |
| REQ-F-021 | MUST | 拡張機能はDiscordへの投稿操作を実行しない。 |
| REQ-F-022 | MUST | 翻訳失敗時、入力欄の下書きを変更しない。 |
| REQ-F-023 | MUST | 翻訳中の編集・入力欄交換・移動・OFF後は結果を適用しない。 |
| REQ-F-024 | MUST | 既存の翻訳経路を再利用し、翻訳先ごとにjobとcacheを分離する。 |
| REQ-F-025 | MUST | 置換後も編集を続けられる。「元に戻す」で翻訳前の日本語の下書きへ戻せる。 |

REQ-N-001〜008、REQ-N-010の境界は下書きにも適用する。
下書きと英語訳は拡張機能の永続storageへ保存しない。
既存の受信メッセージの日本語訳と順次表示は維持する。

| ID | 受け入れ条件 | 追跡 |
| --- | --- | --- |
| AC-019 | ON中にボタンが1つ表示される。入力やDOM検出だけでは翻訳要求を送らない。 | REQ-F-018〜019、SPEC-COMPOSE-001〜002 |
| AC-020 | 「明日の会議は10時です。」を英語の下書きへ置換する。途中訳は入力欄へ書かない。投稿は発生しない。 | REQ-F-020〜021、SPEC-COMPOSE-002〜003 |
| AC-021 | 連打で要求を重複させない。空白のみ、上限超過、非対応入力は送信しない。 | REQ-F-019、SPEC-COMPOSE-001〜002 |
| AC-022 | timeout、不正応答、切断時は下書きを保持する。固定codeを表示し、手動再試行できる。 | REQ-F-022、SPEC-COMPOSE-003 |
| AC-023 | 編集、チャンネル移動、入力欄交換、OFF後の応答は下書きを置換しない。 | REQ-F-023、SPEC-COMPOSE-003 |
| AC-024 | 同じ本文の日本語訳と英語訳はjobもcacheも共有しない。同じ翻訳先の重複排除は維持する。 | REQ-F-024、SPEC-COMPOSE-004 |
| AC-025 | 英語訳の反映後も編集できる。「元に戻す」で翻訳直前の下書きを空白・改行も含めて復元する。復元前の英語訳への編集は残さない。翻訳と復元では投稿せず、添付ファイルを保持する。 | REQ-F-025、SPEC-COMPOSE-001〜003、005 |

Node test 58件とPython self-checkは成功した。
下書きの自動テストはAC-019〜025の状態と復元を検証した。
実モデルでは英訳3ケースと既存の日本語訳1ケースが成功した。
2026-10-05、ユーザは新機能が実機で意図どおりと報告した。
新機能の実Chrome受け入れはユーザ確認により合格とする。
個別の異常系・画面別の実機試験内訳は未報告である。
実装順序は [実装計画](../plans/active/2026-10-05-compose-english-translation.md)を参照する。

## 9. 受信翻訳文の5日間保持案（2026-10-05）

状態: 2026-10-05承認・実装済み。Node自動検証成功。実Chrome受け入れはユーザ確認で合格。
本節以外の既存機能の承認状態は変更しない。
AC-014の永続保存禁止に、受信完成訳の例外を設ける。
MUSTは必須、SHOULDは推奨、MAYは任意を表す。

### 確定事項

- 利用者は、表示された受信メッセージの翻訳文を5日間保持したい。
- 利用者は、投稿入力欄の下書きと英語訳を永続保存しない。
- 利用者は、投稿用の既存30分のメモリキャッシュを維持する。

### 承認済み追加要求

| ID | レベル | 要求 |
| --- | --- | --- |
| REQ-F-026 | MUST | 受信メッセージの検証済み完成訳だけを端末内に保存する。 |
| REQ-F-027 | MUST | 正常保存済みの完成訳を、初回保存成功から120時間保持する。 |
| REQ-F-028 | MUST | ON中は表示メッセージに一致する有効な保存訳を自動復元する。 |
| REQ-F-029 | MUST | メッセージIDと原文のハッシュで保存訳を照合する。 |
| REQ-F-030 | MUST | 保存訳の検索と復元では翻訳APIを呼ばない。 |
| REQ-F-031 | MUST | 下書き、投稿用の英語訳、原文、途中訳、失敗結果を永続保存しない。 |
| REQ-F-032 | MUST | OFF、編集、DOM交換、ID変更後に旧検索結果を表示しない。 |
| REQ-N-012 | MUST | 保存失敗を固定codeで表示し、完成訳と原文を保持する。 |
| REQ-N-013 | MUST | 有効期間内の保存訳を件数制限やLRUで早期削除しない。 |

REQ-N-001〜010の既存通信・ログ・権限の境界を維持する。
5日間の保存は受信翻訳専用とし、既存メモリキャッシュと分ける。
復元時に保存期限を延長しない。
保存できなかった完成訳の5日間保持は保証しない。
期限切れデータは直ちに復元対象から外す。
期限切れデータの物理削除は次のworker起動または保存操作で行う。

### 承認済み受け入れ条件

| ID | 受け入れ条件 | 追跡 |
| --- | --- | --- |
| AC-026 | チャンネル、DM、スレッドで遷移後に完成訳が復元される。再読込とworker再生成後も復元される。復元によるPOSTは0件である。 | REQ-F-026〜028、030、SPEC-CACHE-001〜003 |
| AC-027 | 保存から120時間未満は復元される。120時間以上は復元されない。復元やOFF/ONで期限が延びない。有効な保存訳を早期削除しない。 | REQ-F-027、REQ-N-013、SPEC-CACHE-002 |
| AC-028 | 編集後、同文の別メッセージ、返信プレビューへ旧訳を表示しない。検索中のOFF、DOM交換、ID変更で旧結果を破棄する。 | REQ-F-029、032、SPEC-CACHE-003 |
| AC-029 | 下書きと投稿用の英語訳は保存されない。途中失敗と保存開始前に購読を解除した受信要求も保存されない。既存メモリキャッシュと共有jobは維持される。 | REQ-F-031、SPEC-CACHE-001 |
| AC-030 | 容量不足や書込み失敗でも完成訳を表示する。保存失敗を固定codeで通知する。読込み失敗から手動翻訳へ進める。本文や訳文をログに出さない。 | REQ-N-012、SPEC-CACHE-004 |
| AC-031 | 複数タブで別メッセージを同時に保存しても更新を失わない。原文は永続保存されない。保存先は同期されない端末内領域である。 | REQ-F-026、031、SPEC-CACHE-001、DESIGN第14節 |

実装と検証の範囲は[実装計画](../plans/active/2026-10-05-received-translation-cache.md)に記載する。

AC-026〜031の自動検証はNode test 70件で成功した。
2026-10-05、ユーザはページ遷移後の訳文復元を実Chromeで確認した。
新機能の受け入れはユーザ報告により合格とする。
個別の画面と異常系の実機試験内訳は未報告である。
実時間5日経過の確認は未実施である。
5日期限は時計差替えによる境界テストで確認した。

## 10. 翻訳ボタンのテーマ対応（2026-10-05）

状態: 2026-10-05承認・実装済み。ユーザの実機再確認で合格し、タスク完了。
MUSTは必須を表す。
既存機能の承認状態は維持する。

### 確定事項と承認済み範囲

- 確定事項: 翻訳ボタンはlight modeとdark modeの両方に対応する。
- 確定事項: 翻訳ボタンの配色は自動で切り替わる。
- 承認済み: 追従先はOSのテーマではなく、Discordの表示テーマとする。
- 承認済み: 「翻訳」「英語に翻訳」「再試行」「元に戻す」を対象とする。
- 承認済み: 「確認中…」「翻訳中…」の無効状態も対象とする。
- 承認済み: 実機確認はユーザが行う。
- 対象外: popup、訳文ブロック、翻訳処理の変更。

### 承認済み追加要求: 翻訳ボタンのテーマ対応

| ID | レベル | 要求 |
| --- | --- | --- |
| REQ-F-033 | MUST | 対象ボタンの配色をDiscordの表示テーマに自動で合わせる。 |
| REQ-F-034 | MUST | 表示中のテーマ変更を再読込やボタン再生成なしで反映する。 |
| REQ-N-014 | MUST | 両テーマで通常、hover、focus、disabledの表示を識別できる。 |

### 承認済み受け入れ条件: 翻訳ボタンのテーマ対応

| ID | 受け入れ条件 | 追跡 |
| --- | --- | --- |
| AC-032 | 両テーマで全対象ボタンの背景、文字、境界線が判別できる。有効なボタンの文字と背景のコントラスト比は4.5:1以上である。 | REQ-F-033、REQ-N-014、SPEC-THEME-001 |
| AC-033 | lightからdark、darkからlightへ変更すると既存ボタンの配色が変わる。ボタンの状態、下書き、翻訳結果は保持される。切替による翻訳POSTは0件である。 | REQ-F-034、SPEC-THEME-001 |
| AC-034 | OSとDiscordのテーマが異なる場合もDiscordの表示テーマに従う。利用者による拡張機能のテーマ設定は不要である。 | REQ-F-033、SPEC-THEME-001 |
| AC-035 | 両テーマで有効なボタンのhoverとキーボードfocusが判別できる。disabled中は押下を受け付けず、hoverで有効状態の配色にならない。 | REQ-N-014、SPEC-THEME-001 |

検証方法はDESIGN第15節に記載する。
Node test 70件とJavaScript構文検証は成功した。
AC-032〜035の配色とテーマ切替は自動テストの検証対象外である。
AC-032〜035の実機受け入れはユーザの再確認報告により合格とする。
初回の実機確認では、両テーマで全ボタンの視認性が不合格だった。
ユーザは「ほとんど何も見えない」と報告した。
CSSの配色を修正した。
2026-10-05、ユーザは実機再確認の合格とタスク完了を指定した。
個別の操作状態の試験内訳とコントラストの実測値は未報告である。
Open Questions: なし。


## 11. ローカル / ChatGPT の選択 (2026-10-12)

状態: 完了。Node test 91件成功。補助と実 API による固定文の日訳・英訳は成功。2026-10-12のユーザ実機動作確認により、本変更の実 Chrome 受け入れは合格。
本節はローカル専用の要求と制約に選択可能な例外を設ける。
REQ-N-001、005 と AC-007 の offline 条件はローカルに適用する。
REQ-F-009、014、015 の接続先と popup 制限は本節で拡張する。
CON-003 の例外として ChatGPT 認証・翻訳専用の補助を追加する。
ローカルの公式 MLX サーバは維持する。

| ID | 要求 | 仕様 |
| --- | --- | --- |
| REQ-P-001 | MUST: popup で local / chatgpt を選択し、初期値は local とする。 | SPEC-PROVIDER-001 |
| REQ-P-002 | MUST: ChatGPT 時は本文の外部送信と利用枠の消費を明示する。 | SPEC-PROVIDER-001 |
| REQ-P-003 | MUST: 公開 OAuth と利用許可で認証し、tokens を保護した端末内ファイルに保存する。 | SPEC-PROVIDER-002 |
| REQ-P-004 | MUST: Node 標準機能の補助が外部通信を所有し、固定翻訳用途だけを受け付ける。 | SPEC-PROVIDER-003 |
| REQ-P-005 | MUST: 切断後の遅延 callback / refresh で認証情報を復活させない。 | SPEC-PROVIDER-002 |
| REQ-P-006 | MUST: 翻訳先別に cache と job を区別し、切替時の古い表示を破棄する。 | SPEC-PROVIDER-004 |
| REQ-P-007 | MUST: 既存のローカル翻訳、入力検証、timeout、手動操作、5日保存を維持する。 | SPEC-PROVIDER-001〜004 |

| 受け入れ条件 | 検証 |
| --- | --- |
| 未接続では ChatGPT を有効化しない。local は MLX health を使う。 | popup の動作 test |
| 不正 state、claims、署名、scope、origin、payload を拒否する。 | 署名付き fixture / HTTP test |
| refresh を直列化し、切断後の保存を拒否する。 | 非同期競合 test |
| 完了前の切断、incomplete、usage 欠落を cache しない。 | streaming test |
| provider が異なる同文を dedupe / 復元しない。 | queue / cache / worker test |
| 切替で古い結果を適用せず、入力欄の下書きを保持する。 | content lifecycle test |
| 実サインインと実翻訳が成功する。 | 認証と実機動作はユーザ報告で合格。固定文の日訳・英訳は実 API で成功 |
| Chrome 上で選択、LNA、切断、両翻訳先を操作できる。 | 本変更の実機受け入れはユーザ報告で合格。個別操作の試験内訳は未報告 |

2026-10-12、ユーザは実機で動作確認できたと報告し、完了を指示した。
エージェント自身の実 Chrome 操作、個別の異常系、利用枠上限と長文品質の実機検証は行っていない。
