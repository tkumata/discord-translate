# 仕様書

## 1. 概要

本書は Discord Translator の外部動作と入出力を定義する。
要件は [REQUIREMENTS.md](REQUIREMENTS.md)、責務は [DESIGN.md](DESIGN.md) を参照する。
MUST は必須の動作または生成指示を表す。
モデルの意味解釈と書式の遵守は、構造検証の保証対象に含めない。

## 2. 対象要件

- REQ-F: 受信翻訳、順次表示、下書き英訳、キュー、保存、画面操作。
- REQ-P: 翻訳先、認証、Native 起動、Node.js の解決。
- REQ-N: 通信、ログ、期限、保存失敗、アクセシビリティ。
- REQ-SC: 依存・モデルの固定と検証。
- REQ-POPUP / REQ-NUANCE: ポップアップと受信訳の補足。

## 3. システム動作

### SPEC-PROVIDER-001 選択と有効化

設定は `enabled:boolean` と `provider:"local"|"chatgpt"` とする。
初期値は `enabled:false`、`provider:"local"` である。

| 操作 | 動作 |
| --- | --- |
| 翻訳先を切り替える | `provider` と `enabled:false` を保存し、旧 UI と購読を破棄する。選択先サーバを起動する。 |
| OFF から ON | 選択先の Native readiness と接続を確認する。成功した場合だけ有効化する。 |
| ON から OFF | 接続確認なしで表示と購読を破棄する。下書き、保存訳、サーバは維持する。 |
| ChatGPT 接続 | 補助の認証開始 URL を開く。認証後はポップアップを開き直して有効化する。 |
| ChatGPT 切断 | OFF にして認証情報を削除する。遠隔失効が未確認なら案内を表示する。 |

local の接続確認は、5秒以内の `GET /health` を使う。
HTTP 200 と、厳密な `{"status":"ok"}` を成功条件とする。
ChatGPT は `/status` の `connected:true` と非空のモデル名を確認する。
有効化だけでは、新しい翻訳を依頼しない。

### SPEC-EXT-001 有効化とメッセージ単位の手動翻訳UI

ON 中は現在表示中と新規の対象本文を走査する。
有効な保存訳があれば復元し、なければ「翻訳」を1つ表示する。
検索中は「確認中…」として押下を抑止する。
「翻訳」または「再試行」の押下で、対象本文だけを要求する。
要求開始後は「翻訳中…」として重複押下を抑止する。

訳文は原文の直後に `lang="ja"` のブロックとして表示する。
ラベルは「日本語訳・補足」とする。
生成中のラベルは「日本語訳・補足（翻訳中…）」とする。
本文全体を `textContent` へ設定し、改行を保持する。
HTML や Markdown の追加レンダリングは行わない。

失敗時は途中訳を除去し、原文、固定コード、「再試行」を残す。
本文や ID の変更、DOM 交換、削除、OFF 後の結果は表示しない。

### SPEC-EXT-002 Discord DOM 識別と本文

対象コンテナは `li[id^="chat-messages-"]` である。
ID は `^chat-messages-[0-9]+-[0-9]+$` と一致しなければならない。
本文はコンテナ自身に対応する `message-content-<末尾ID>` から取得する。
同じコンテナ内の返信プレビューや別 ID の本文は除外する。
受信本文は `textContent.trim()` で取り出す。
空文字と8,000 UTF-16 コード単位を超える本文は対象外とする。

<a id="12-訳文の順次表示と入力kv-cache2026-10-02"></a>

### SPEC-STREAM-001 要求と stream 応答

翻訳は `stream:true` で要求する。
SSE の本文差分を連結し、累積文字列を UI へ送る。
受信訳は途中から表示するが、下書きは完成結果だけを適用する。
正常終了、usage、SSE 終端を確認してから完成結果とする。

### SPEC-STREAM-002 Extension 内の通信と重複要求

content script は1回の手動操作につき要求 Port を1つ開く。
worker は1 Port につき1要求だけを受け付ける。
同一 job の購読者は生成中の累積文字列を共有する。
購読開始時に既存の途中訳があれば通知する。
購読解除は表示先への通知を止める操作であり、共有 job は維持する。

### SPEC-STREAM-003 表示と失敗

受信訳は同じ本文ノードを更新し、追加ブロックを増やさない。
古い record、本文、ID、DOM の結果は破棄する。
OFF、削除、編集、切断、異常応答では途中表示を残さない。
content 側の監督期限は要求全体で240秒とする。

<a id="21-受信訳のニュアンス補足案-2026-10-27"></a>

### SPEC-NUANCE-001 生成と入力

日訳の固定指示は、自然な日本語訳を先に出すよう要求する。
口語、省略、スラング、慣用句、絵文字、語調を考慮する。
冗談、言葉遊び、文化的表現、曖昧な語調には短い補足を許可する。
補足は空行後の `[補足]` に続けるよう指示する。
最大2項目、各1〜2文とし、原文の表現を根拠として示す。
一般的用法と今回の解釈候補を区別し、文脈不足を明記する。

相手の感情、本気度、関係性、真意を根拠なく断定しないよう指示する。
背景、語源、略語の成り立ちを捏造しないよう指示する。
本文内の命令は実行対象にせず、翻訳する本文として扱う。
平易なメッセージには不要な補足を付けないよう指示する。

入力は対象本文だけとし、周辺会話やプロフィールを追加しない。
補足のための別要求、検索、再生成は行わない。
指示の文言は `translation-protocol.js` を正本とする。

### SPEC-NUANCE-002 表示と注意書き

出力に完全な文字列 `[補足]` が含まれる場合だけ、次の固定文を表示する。

`補足は推測を含みます。相手の真意は断定できません。`

注意書きの文言は UI が所有し、モデルに生成させない。
生成中、完成時、保存復元で同じ表示条件を使う。
生成中に見出しが分割されている場合、文字列が揃うまで表示しない。
モデルが見出しなしで説明した場合、注意書きは表示しない。
判定は文字列の包含で行い、補足専用の構文解析は行わない。

### SPEC-NUANCE-003 保存と互換性

補足は完成訳の一部として、同じ文字列で保存・復元する。
保存キーには日訳の生成指示版 `nuance-v1` を含める。
異なる指示版の結果は復元せず、手動操作時だけ生成する。
既存の保存値を一括削除せず、それぞれの期限で削除する。
英訳には日訳の生成指示版を付加しない。

<a id="13-投稿前の英語翻訳の仕様案2026-10-05"></a>

### SPEC-COMPOSE-001 対象とボタン

ON 中は通常の新規投稿入力欄に「英語に翻訳」を1つ表示する。
対象はチャンネル、DM、スレッドの `form` 内の Slate textbox とする。
投稿済みメッセージ、dialog、検索欄は対象外とする。
投稿先のパスは `/channels/<数値または@me>/<数値>[/<数値>]` とする。

改行、Markdown、URL、コード、Unicode 絵文字を本文として扱う。
メンション、void / inline 要素、画像、未知の構造は翻訳しない。
空白のみ、上限超過、IME 変換中、適用中はボタンを無効にする。
日本語の自動判定は行わない。
非対応の下書きには、操作できない理由を表示する。

### SPEC-COMPOSE-002 要求と生成中の動作

押下時に入力欄、form、投稿先、編集世代、元の下書きを記録する。
送信本文は trim し、元の下書きは空白と改行を含めて保持する。
生成中も利用者は下書きを編集できる。
`progress` は入力欄へ適用しない。

### SPEC-COMPOSE-003 成功・失敗・古い結果

完成結果を適用する前に、次の一致を検証する。

- 有効な record と、接続中の同じ入力欄・form。
- 同じ投稿先のパスと編集世代。
- 空白と改行を含む、要求時の下書き全文。

編集後に同じ本文へ戻っても、旧世代の結果は適用しない。
反映は入力欄全体への paste 相当の `beforeinput` で行う。
反映後の Slate 本文が期待する文字列と一致した場合だけ成功とする。
成功後も入力欄で編集を継続できる。
反映できなかった場合は、更新失敗を表示する。
翻訳の失敗では下書きを保持し、固定コードで手動再試行を案内する。
自動再試行、送信ボタンの操作、Enter の生成、投稿 API 呼出しは行わない。
添付ファイルは操作しない。

### SPEC-COMPOSE-004 翻訳方向と共有経路

`translate` は日本語、`translateDraft` は英語として worker が決定する。
呼出し元から任意の prompt、URL、API payload を受け取らない。
英訳指示は自然な英語と訳文だけの出力、不変要素の保持を要求する。
両方向で同じキュー、bridge、期限、完成結果検証を使用する。

### SPEC-COMPOSE-005 「元に戻す」ボタン

成功した英訳の近くに「元に戻す」を表示する。
対象は直近の成功した翻訳の直前の下書き1件とする。
英訳を編集した後も、翻訳前の空白・改行を含む全文へ戻す。
次の翻訳の成功で復元対象を更新し、失敗だけでは更新しない。
復元成功後は対象とボタンを除去する。
復元失敗時は対象を保持して失敗を表示する。
翻訳中、適用中、IME 変換中、非対応入力では復元を抑止する。

復元対象は同じ入力欄のメモリだけに保持する。
入力欄の空化、投稿先移動、入力欄交換、OFF では破棄する。
復元では翻訳要求、投稿、添付ファイルの変更を行わない。

### SPEC-THEME-001 表示テーマとボタンの状態

Discord 内の翻訳、再試行、復元ボタンは Discord のテーマへ追従する。
CSS 変数と `.theme-light`、暗色テーマのクラスを使用する。
通常、hover、focus-visible、disabled の状態を分ける。
テーマ変更で要求、下書き、翻訳結果を更新しない。

### SPEC-POPUP-001 情報と操作の配置

ポップアップは見出し、翻訳先、ChatGPT 接続、有効化の順に配置する。
ChatGPT 接続欄は `chatgpt` 選択時だけ表示する。
接続済みの場合はアカウントとモデル名を表示する。
操作は `Continue with ChatGPT`、切断、利用量の管理リンクとする。
接続状態は表示時と ChatGPT 選択時に取得する。
手動の接続状態確認ボタンは設けない。

操作中は競合する操作要素を無効にする。
有効化の接続確認中、成功、失敗を状態欄へ表示する。
失敗時は固定エラーコードを別表示する。
状態通知、label、`aria-describedby`、キーボード focus を使用する。
明暗配色は `prefers-color-scheme` で切り替える。
長いアカウント、モデル名、エラー文は折り返す。

## 4. 状態

| 対象 | 状態と遷移 |
| --- | --- |
| 設定 | 初期 OFF。接続確認成功で ON。OFF 操作と翻訳先切替で OFF。 |
| 受信 record | lookup → 保存訳の succeeded、または idle → pending → succeeded / failed。 |
| 下書き | 編集可能 → 翻訳中 → 完成結果の反映、または失敗。編集で購読を解除する。 |
| job | queued → running → 完了 / 失敗。待機期限超過は expired。 |
| Native 接続 | 未接続 → 起動待ち → ready。切断や不正通知で接続を破棄する。 |

失効・解除した購読へ結果を適用しない。
不完全な結果を保存済み・完了として表示しない。

## 5. インターフェース

### SPEC-EXT-003 messagingとtrust boundary

| 用途 | メッセージ |
| --- | --- |
| 受信訳 | `{type:"translate", messageId, text}` |
| 下書き英訳 | `{type:"translateDraft", text}` |
| 保存検索 | `{type:"lookupTranslation", messageId, text}` |
| サーバ起動 | `{type:"startTranslationServer", provider}` |
| 途中訳 | `{type:"progress", text}` |
| 受信完成結果 | `{type:"result", text, cache:{saved,error}}` |
| 下書き完成結果 | `{type:"result", text}` |
| 失敗 | `{type:"error", error}` |
| 検索結果 | `{status:"hit", text, error}` または `{status:"miss", error}` |

要求 Port 名は `discord-translate-request` とする。
受信要求と検索は、同じ拡張 ID、top frame、数値 tab ID を必要とする。
sender URL の protocol は `https:`、hostname は `discord.com` とする。
plain object、既定キーだけの形式、本文、ID を検証する。
サーバ起動操作は、自拡張の `popup.html` からだけ受け付ける。

### SPEC-EXT-004 Manifest V3と権限

content script は `https://discord.com/*` の top frame で実行する。
権限は `storage` と `nativeMessaging` とする。
HTTP の host permission は `127.0.0.1:8080` と `127.0.0.1:8766` に限定する。
ページ公開リソースは Discord 向けの `bridge.html` だけとする。
拡張 CSP は同梱 script と固定 loopback 接続だけを許可する。

### SPEC-EXT-005 Extension document bridge

bridge は非表示 iframe 内の拡張 document である。
Port 名は `discord-translate-bridge` とする。
worker は拡張 ID、tab、子 frame、完全な bridge URL を検証する。
要求は同じ tab の bridge だけへ送る。
未接続の場合は最大5秒待機する。
応答は接続、tab、job ID に対応付ける。

bridge は固定 payload を検証し、翻訳先に応じた固定 URL へ POST する。
ページの `postMessage` や任意の URL は受け付けない。
OFF とタブ破棄で iframe を除去する。
bridge Port 切断時は実行中の HTTP を abort する。

### SPEC-API-001 Chat completion

| 翻訳先 | Endpoint | 追加ヘッダ |
| --- | --- | --- |
| local | `POST http://127.0.0.1:8080/v1/chat/completions` | なし |
| chatgpt | `POST http://127.0.0.1:8766/v1/chat/completions` | `X-Discord-Translate: 1` |

Content-Type は `application/json` とする。
共通 payload は次の値とする。

```json
{
  "messages": [
    {"role": "system", "content": "翻訳方向に応じた固定指示"},
    {"role": "user", "content": "trim 済みの対象本文"}
  ],
  "chat_template_kwargs": {"enable_thinking": false},
  "temperature": 0.7,
  "top_p": 0.8,
  "top_k": 20,
  "min_p": 0,
  "max_tokens": 1024,
  "stream": true,
  "stream_options": {"include_usage": true}
}
```

### SPEC-API-002 翻訳 prompt

日訳は SPEC-NUANCE-001、英訳は SPEC-COMPOSE-004 の指示を使う。
指示と本文を連結せず、独立した system / user message に格納する。
両方向で改行、Markdown、URL、識別子、コード、絵文字の保持を指示する。
日訳の補足以外に、説明や原文の反復を出さないよう指示する。

### SPEC-API-003 成功応答

bridge は HTTP 200 と `text/event-stream` を成功候補とする。
UTF-8 と SSE を検証し、`data: [DONE]` まで処理する。
終端より前の EOF、不正 JSON、イベント上限超過は失敗とする。
各イベントの上限は1 MiB とする。

worker は次の条件を検証する。

- 差分は1 choice と assistant のテキストだけである。
- tool / function call と reasoning フィールドがない。
- `finish_reason` は `stop` であり、途中終了ではない。
- usage は終了後に1回あり、`total_tokens` は0以上の整数である。
- 完成本文は trim 後に非空である。
- 本文に `<think>` / `</think>` が含まれない。
- 累積本文は64 × 1,024 UTF-16 コード単位以内である。

分割された thinking marker とサロゲートペアの末尾は表示を保留する。
`finish_reason=length` は成功にしない。
完成結果の構造検証は、訳文や補足の意味を判定しない。

### SPEC-API-004 Health と readiness

local の `/health` は公式サーバの `{"status":"ok"}` を使う。
HTTP の正常性とモデルの翻訳品質は別に扱う。
Native ready には、自分が起動した子の listener 所有も必要とする。
ChatGPT は補助の `/status` で認証状態を確認する。

### SPEC-PROVIDER-002 認証と保管

認証は `https://auth.openai.com` の公開 OAuth を使う。
resource は `https://api.openai.com/v1` とする。
PKCE S256、state、nonce、ID token の署名と claims を検証する。
利用枠の scope とアカウントの一致も検証する。
認証トランザクションの期限は10分とする。

認証情報は `~/.config/discord-translate/chatgpt.json` に保存する。
親ディレクトリは0 700、ファイルは 0600 とする。
有効期限まで60秒以下の場合は refresh を共有して実行する。
モデルは接続時に取得した利用可能一覧から選択し、保存する。

保存は世代の一致と直列のファイル置換で保護する。
切断は tokens とモデルを消し、実行中の要求を abort する。
遅延 callback / refresh は切断後の情報を復活させない。
refresh token の遠隔失効を試み、確認できなければ UI で知らせる。

### SPEC-PROVIDER-003 補助の HTTP と推論

補助は IPv4 loopback の 8766 で待ち受ける。
Host は listener と一致し、Origin があれば登録拡張と一致する必要がある。
認証タブのルート以外では `X-Discord-Translate: 1` を必要とする。

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/status` | 接続状態、アカウント、モデル。 |
| POST | `/auth/start` | 一時的な `/auth/login?state=...` URL を返す。 |
| GET | `/auth/login` | state を検証し、認証先へリダイレクトする。 |
| GET | `/auth/callback` | OAuth を完了し、ポップアップへの案内を返す。 |
| POST | `/auth/logout` | 端末内認証を削除し、遠隔失効の結果を返す。 |
| POST | `/v1/chat/completions` | 固定翻訳指示を検証して推論する。 |

CORS preflight は登録拡張、ルートの method、許可ヘッダを検証する。
翻訳の JSON 本文上限は64 KiB とする。
任意の指示は受け付けず、製品の固定日訳・英訳指示と照合する。

Responses への変換結果は `model`、`instructions`、`input`、`store:false`、`stream:true` とする。
MLX 用の生成パラメータは Responses へ転送しない。
OpenAI 側の保持方針を、`store:false` だけで保証しない。

補助は本文 delta と対応する完成 message、ID、index、usage を検証する。
終端の output が省略された場合も、検証済みの完成 message を必要とする。
refusal、failed、incomplete、tool 出力、不一致を成功にしない。
upstream の reasoning は表示へ流さず、本文と区別して扱う。
検証後に共通の chat completion SSE へ変換する。

### SPEC-PROVIDER-005 Native Messaging による起動

host 名は `com.discord_translate.local` と `com.discord_translate.chatgpt` とする。
登録先は macOS Chrome の `NativeMessagingHosts` とする。
`allowed_origins` は登録した拡張 ID の1件だけとする。
caller は `chrome-extension://<32文字の拡張ID>/` と一致させる。

Native host はサーバ起動後に `{type:"ready"}` を1回通知する。
通知は native endian の4 byte 長と UTF-8 JSON で framing する。
stdin の任意データ、コマンド、本文は受け付けない。
EOF、signal、サーバ終了で停止処理を実行する。
Native stdout に診断や子プロセスの出力を混在させない。

### SPEC-PROVIDER-006 起動先の選択と停止

worker の初期化、Chrome の起動通知、翻訳先変更で選択先を起動する。
ポップアップ操作と翻訳要求の前にも readiness を確認する。
同じ翻訳先の起動待ちは共有し、切替時は旧 Port を閉じる。
worker は設定変更の世代を照合し、古い起動要求を採用しない。

local は固定の `start-server.sh` を子プロセスとして起動する。
listener の所有を `/usr/sbin/lsof` で確認してから health を確認する。
他のプロセスの8080 listener を採用・停止しない。
停止時は所有するプロセスグループへ SIGTERM を送り、1秒後まで残れば SIGKILL を送る。
ChatGPT 補助は bind 成功後に認証情報を初期化する。
既存8766 listener に競合した別起動は、認証情報へ触れる前に失敗する。

OFF は Native Port を維持する。
翻訳先切替、拡張の無効化、Chrome 完全終了による Port 終了はサーバを停止する。
自動起動は本文送信や推論の契機にしない。

### SPEC-PROVIDER-007 起動時の Node.js 選択

installer は登録時の `process.execPath` から nvm 配下かを判定する。
nvm 配下は管理ルートを保存し、起動時に `versions/node/v*/bin/node` を調べる。
各候補の実行結果から、Node.js 24 以上かつ LTS の版を選ぶ。
数値のバージョン順で最新版を使う。
nvm の alias、npm の版、最小 PATH に依存しない。
シェル初期化ファイルと `nvm.sh` は実行しない。
対応版がなければ `native_host_node_unavailable` で終了する。
自動取得は行わない。

nvm 管理外では、登録した Node.js の絶対パスを使う。
実行パス、管理ルート、リポジトリ位置、拡張 ID を変えた場合は再登録する。

### SPEC-SRV-001 起動入力

ローカル起動スクリプトは、次の環境変数を受け付ける。

| 変数 | 条件 |
| --- | --- |
| `MODEL` | 既定は台帳の Qwen3.5-9B。台帳で検証できるモデル名だけ。 |
| `PORT` | 1〜65535 の整数。既定8080。 |
| `CORS_ORIGIN` | `chrome-extension://` と32文字の拡張 ID。必須。 |

不正入力、実行ファイル不在、モデル検証失敗では理由を stderr へ出し、終了コード2とする。
拡張の接続先は固定であり、手動で別ポートを指定しても追従しない。
Native 起動では `PORT=8080` を固定し、継承した `MODEL` を使わない。

### SPEC-SRV-002 実行条件

`HF_HUB_OFFLINE=1` と `HF_HUB_DISABLE_TELEMETRY=1` を設定する。
モデル照合後の絶対ローカルパスを、公式 `mlx_lm.server` へ渡す。
localhost bind、登録拡張 CORS、thinking 無効、prompt/decode concurrency 1で起動する。
ログレベルは CRITICAL とする。
手動起動は foreground で動き、`Ctrl-C` で停止する。

### CLI

| コマンド | 用途 |
| --- | --- |
| `python3.14 -I scripts/setup_local.py --python-source '<由来>'` | 固定依存を新しい `.venv` へ導入する。 |
| `./.venv/bin/python -I scripts/model_assets.py fetch` | 台帳のモデルを取得・検証する。 |
| `./.venv/bin/python -I scripts/model_assets.py verify` | 配置済みの全対象ファイルを検証する。 |
| `node scripts/install-native-host.mjs <拡張ID>` | 両 Native host と launcher を登録する。 |
| `CORS_ORIGIN=chrome-extension://<拡張ID> ./scripts/start-server.sh` | ローカルを手動起動する。 |
| `python3 -I scripts/verify.py --self-check` | 外部通信なしで検証 CLI 自体を確認する。 |

依存導入は `--venv`、モデル操作は `--model` を指定できる。
`fetch --from-cache <path>` は既存の取得物を複製・検証する。
`verify` と `--from-cache` の併用は拒否する。
Python の導入・モデル検証の失敗は終了コード2とする。

## 6. データ仕様

### SPEC-QUEUE-001 queue、重複排除、cache

キューは両翻訳先・両方向を共通の FIFO で扱う。
本文の正規化と非同期 hash 計算は受付順を維持する。
同一キーの要求は1 job へまとめ、完成結果を共有する。
同時実行は1、実行中と待機中を合わせた unique job の上限は64とする。

メモリキャッシュは最大256件の LRU、保存から30分とする。
失敗した結果は保存しない。
受信と下書きで同じ仕組みを使い、翻訳方向と翻訳先をキーで分離する。

### キャッシュの識別

`translationCacheSource` の JSON 文字列を UTF-8 にして SHA-256 を計算する。

| 翻訳先と方向 | hash の入力 |
| --- | --- |
| local 日訳 | `["ja", trim済み本文, "nuance-v1"]` |
| chatgpt 日訳 | `["chatgpt", "ja", trim済み本文, "nuance-v1"]` |
| local 英訳 | `["en", trim済み本文]` |
| chatgpt 英訳 | `["chatgpt", "en", trim済み本文]` |

<a id="14-受信翻訳文の永続キャッシュ案2026-10-05"></a>

### SPEC-CACHE-001 保存対象と識別

保存先は `chrome.storage.local` とする。
キーは `receivedTranslation:v1:<messageId>:<hash>` とする。
値は `{version:1, text, savedAt, expiresAt}` とする。
`text` は補足を含む検証済み完成結果である。
時刻はミリ秒単位の有限な非負数とする。

保存開始前に購読を解除した受信要求は保存しない。
メモリ cache hit の受信結果も、対象 ID に保存する。
同文でも別メッセージの保存訳は自動復元しない。
下書きと投稿用英訳、途中結果、失敗結果は永続保存しない。
原文全文を独立したデータで保存しない。
補足内の原文引用は、完成結果の一部として保存する。

### SPEC-CACHE-002 寿命と削除

`expiresAt = savedAt + 432000000` とする。
`now < expiresAt` の場合だけ有効とする。
有効期間内の再保存と復元では `savedAt` を維持する。
worker 起動時と保存前に期限切れ・不正値を削除する。
検索で該当する期限切れ・不正値を見つけた場合も削除する。
削除失敗でも有効期限の判定は緩めない。

OFF、worker 再生成、Chrome 再起動では保存訳を削除しない。
拡張の削除とストレージの明示削除は保持対象外とする。
拡張停止中の物理削除は保証しない。
有効な保存訳を、件数上限や LRU で早期削除しない。
設定項目は削除対象に含めない。

### SPEC-CACHE-003 検索と表示

ON 中の初回検出と再描画で、保存訳を検索する。
検索は翻訳キュー、bridge、翻訳 API を呼ばない。
検索中の重複検索と手動押下を抑止する。
hit は完成訳ブロック1つを復元し、miss は「翻訳」を表示する。
結果の受取時に、本文、ID、record、DOM、有効状態を再照合する。
UI だけが失われた場合も、現在の対象に一致する結果を復元する。

### SPEC-CACHE-004 容量とエラー

Chrome のストレージ割当を使用し、追加の容量権限は要求しない。
保存操作は直列化し、複数メッセージの保存による更新消失を防ぐ。
操作の監督期限は5秒とする。

書込み失敗でも完成訳は表示し、保存失敗を固定コードで通知する。
quota エラーでは期限切れ項目を削除し、1回だけ再試行する。
有効な他の保存訳は削除しない。
自動検索の読込み失敗は固定コードを console に記録し、手動翻訳を可能にする。
読込み失敗だけで Discord 上に警告は出さない。

`cache.saved` は保存成否を示す。
正常時の `cache.error` と検索の `error` は `null` とする。
削除失敗は保存成功時にも `cache_cleanup_failed` で通知できる。

### SPEC-KV-001 入力 KV cache

入力 KV cache は公式 MLX サーバの機能に任せる。
製品固有の server-side 訳文キャッシュは持たない。
`verify.py --streaming` は、後続要求の cached token 情報も確認する。
KV cache の観測結果を、意味の品質や端末内保存の保証と混同しない。

## 7. エラー仕様

### SPEC-ERR-001 クライアント判定

| コード | 条件 |
| --- | --- |
| `invalid_sender` / `invalid_input` | 送信元、形式、本文、ID が不正。 |
| `hash_error` | SHA-256 を利用・計算できない。 |
| `queue_full` / `queue_timeout` | job 上限、または待機期限超過。 |
| `request_timeout` | 要求の監督期限超過。 |
| `bridge_unavailable` | 正規 bridge が接続できない、または切断された。 |
| `lna_denied` | 翻訳通信が `NotAllowedError` / `SecurityError` で拒否された。 |
| `network_error` | その他の通信失敗、Native 起動失敗、未知の失敗。 |
| `http_error` | 翻訳先の HTTP が200以外。ChatGPT の下記例外を除く。 |
| `invalid_response` | 応答、SSE、完了理由、usage、本文が検証に失敗。 |
| `chatgpt_auth_required` | ChatGPT が401 / 403を返した。 |
| `chatgpt_usage_limit` | ChatGPT が429を返した。 |
| `cache_read_failed` / `cache_write_failed` / `cache_cleanup_failed` | 保存訳の読込み、書込み、削除の失敗。 |

有効化では `health_timeout`、`health_network_error`、`health_http_error`、
`health_invalid_response`、`lna_denied` を使う。
起動・認証には `local_unavailable`、`chatgpt_unavailable`、`chatgpt_not_connected` を使う。
例外詳細や本文を利用者向けのコードへ混入させない。

### SPEC-ERR-002 サーバ停止と復旧

サーバ停止や接続切断を成功扱いにしない。
受信では原文と再試行、下書きでは編集内容を保持する。
Native 接続の失敗後は、次の操作で接続を再試行できる。
翻訳と有効化の無限再試行は行わない。

## 8. 境界条件

| 項目 | 上限・期限 |
| --- | --- |
| 正規化済み入力 | 1〜8,000 UTF-16 コード単位。 |
| 累積出力 | 64 × 1,024 UTF-16 コード単位。 |
| MLX 出力指定 | `max_tokens:1024`。ChatGPT は adapter の Responses 設定を使う。 |
| unique job | 実行中と待機中を合わせて64件。 |
| キュー待機 / 要求実行 / bridge fetch | 各120秒。待機時間は実行開始で切り替わる。 |
| content の要求全体 | 240秒。途中通知では延長しない。 |
| bridge 接続待ち | 5秒。 |
| local の起動処理 / worker の ready 待ち | 120秒 / 130秒。 |
| ChatGPT の ready 待ち | 15秒。 |
| local health / 保存検索・保存操作 | 5秒。 |
| ポップアップの ChatGPT HTTP 操作 | 15秒。 |
| 認証の外部 HTTP | 10秒。 |
| メモリ cache | 256件、30分。 |
| 受信保存訳 | 120時間。有効な値の早期削除なし。 |

起動待ち、ブラウザ側の監督、各操作の期限は独立している。
要求の途中終了や上限到達を完成結果として扱わない。

## 9. 互換性とセキュリティ

### SPEC-SEC-001 ネットワーク境界

local は `127.0.0.1:8080`、ChatGPT 補助は `127.0.0.1:8766` に bind する。
同一端末の別プロセスからの任意要求を排除する認証とは扱わない。
手動サーバとの併用や、別 Chrome プロファイルの同時利用は対象外とする。

### SPEC-SEC-002 CORS境界

CORS は登録拡張 origin だけを許可する。
`*` と Discord ページ origin は許可しない。
CORS と loopback bind を、同一ユーザのプロセスに対する認証と混同しない。

### SPEC-SEC-003 外部通信

local の通常起動と翻訳は、モデルを取得せず Mac 内で行う。
初回の依存・モデル取得だけは外部通信を行う。
chatgpt は認証先と OpenAI API に接続し、指定本文と固定指示を送る。
周辺会話、原文の履歴、下書きの履歴は収集しない。

### SPEC-SUPPLY-001 依存導入

`setup_local.py` は対象 OS、arm64、CPython 3.14 を確認する。
既存 venv と symlink を上書きしない。
`requirements.txt` の全版と hash を検証する。
pip の設定・環境の上書きを遮断し、PyPI の binary wheel だけを導入する。
`pip check` 後に Python の由来、ソース commit、台帳 hash を導入記録へ保存する。
導入記録を独立した署名として扱わない。

### SPEC-SUPPLY-002 モデル取得と起動

`models.lock.json` でモデル ID、commit、全ファイル、サイズ、hash を固定する。
モデルの配置先は `models/<repo名の区切りを--へ置換>/<commit>/` とする。
取得物を一時領域へ複製し、検証後に配置する。
不足、余分なファイル、サイズ・hash の不一致、管理外パスを拒否する。
許可拡張子は `.json`、`.jinja`、`.safetensors` とする。
独自コード参照と非対応の model/tokenizer 実装を拒否する。
通常起動も全ファイルを検証し、取得や修復を自動実行しない。

### SPEC-SUPPLY-003 拡張機能の実行境界

拡張と Node 補助は同梱 JavaScript と標準ライブラリで動く。
外部 npm パッケージ、remote script、任意コード実行の入口を持たない。
Native の登録先、caller、固定スクリプトを検証する。
コードと台帳を同一ユーザが同時に改変する状況は防御範囲外とする。

### SPEC-LOG-001 ログ

通常の診断は固定コードと、本文を含まない構造情報に限定する。
本文、訳文、prompt、認証 token、例外詳細を診断へ出さない。
MLX は CRITICAL で起動し、Native 子の stdout/stderr を転送しない。
`verify.py` は本文・訳文を出力せず、検証結果や計測情報を出す。
実モデルの意味評価と長時間安定性の結果は、実施範囲を区別して記録する。

## 10. 未決事項

現在の動作を定義するための未決事項はない。
翻訳品質、補足の頻度、DOM 互換性には製品の制約がある。
既知の品質結果と実機確認の範囲は `docs/plans/` の記録を参照する。
