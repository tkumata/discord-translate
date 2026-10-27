# 設計書

## 1. 設計概要

Discord Translator は、Chrome 拡張、翻訳先サーバ、Native host で構成する。
利用者の手動操作を起点に、本文の検証、直列処理、翻訳、表示を行う。
ローカル推論は公式 MLX サーバ、ChatGPT は専用の Node 補助を使う。

本書は現行コードの責務と依存関係を説明する。
外部動作、上限、メッセージ形式は [仕様書](SPECIFICATIONS.md) を正本とする。
製品の要求は [要件定義書](REQUIREMENTS.md) を参照する。

## 2. アーキテクチャ

```text
Discord top frame
  request-client + received-messages + draft-composer
       │ Chrome runtime Port
       ▼
  service-worker ── received-translation-cache ── chrome.storage.local
       │
       ├── translation-queue ── translation-protocol / translation-provider
       │        │ 固定 payload / 検証済み結果
       │        ▼
       │   bridge-registry
       │        │ 同じ tab の検証済み Port
       │        ▼
       │   hidden bridge.html / bridge.js
       │        ├── local → 127.0.0.1:8080 → 公式 MLX
       │        └── chatgpt → 127.0.0.1:8766 → OpenAI Responses
       │
       └── chatgpt-native → 選択先の Native host → サーバの起動・停止

popup → 設定 / 接続確認 / 認証開始・切断
```

service worker は翻訳 HTTP を直接実行しない。
Discord ページと loopback HTTP の間には拡張 document の bridge を置く。
認証情報と OpenAI 通信は ChatGPT 補助へ閉じ込める。

## 3. コンポーネント設計

### content script

`content-script.js` は、有効状態、非表示 bridge、DOM 監視の寿命を所有する。
ON で受信・下書きの担当を作成し、走査を開始する。
OFF で担当を dispose し、observer、iframe、追加 UI を取り除く。
翻訳先の変更でも旧表示と購読を破棄する。

受信本文と投稿入力欄の処理を相互に呼び出さない。
共通する通信は `request-client.js` へ渡す。

### worker とキュー

`service-worker.js` は Chrome API の入口と配線を所有する。
sender と要求を検証し、設定の読取り、Native readiness、翻訳を接続する。
受信完成結果は永続保存へ渡し、下書き結果は保存せず返す。
保存検索はキューと推論へ進めない。

`translation-queue.js` は FIFO、重複排除、メモリキャッシュを所有する。
`requestImpl` で HTTP の実行先を注入し、ブラウザ通信へ直接依存しない。
`runTranslationRequest` は実行期限、stream の構築、完成結果の検証を所有する。

### bridge

`bridge-registry.js` は、tab と bridge Port の対応を管理する。
bridge sender を検証し、job ID ごとに応答を照合する。
同じ tab の接続だけへ固定 payload を送り、abort と切断を処理する。

`bridge.js` は HTTP と SSE、HTTP の abort を所有する。
翻訳先から固定 loopback URL を選び、許可した payload だけを送る。
SSE を構造化 chunk として worker へ返す。
ページの任意メッセージや URL を受付に使わない。

### ポップアップ

`popup.html` は意味構造、操作要素、label、状態通知を所有する。
`popup.css` は配置、明暗配色、長い文字列の折り返しを所有する。
`popup.js` は設定、接続状態、有効化、認証タブ、切断を所有する。

local の health と ChatGPT の status は、ポップアップ document から確認する。
翻訳の HTTP とポップアップの管理操作を混在させない。

### Native host とサーバ

`chatgpt-native.js` は1つの選択先 Native 接続と起動待ちを所有する。
worker は設定変更の世代と選択先を照合する。
Native host はサーバの寿命を Chrome の Port に対応付ける。

local host は既存の起動スクリプトを子プロセスとして動かす。
ChatGPT host は同じプロセスで補助サーバを動かす。
Native の stdout は ready 通知専用とし、本文を転送しない。

## 4. モジュール構成

| ファイル | 責務 |
| --- | --- |
| `extension/manifest.json` | 実行対象、読込順、権限、CSP、公開 bridge。 |
| `extension/content-script.js` | ON/OFF、DOM 監視、受信・下書き・bridge の寿命。 |
| `extension/request-client.js` | 要求 Port、イベント検証、content の期限、固定エラー文。 |
| `extension/received-messages.js` | 本文の特定、保存検索、受信ボタン、順次表示、注意書き。 |
| `extension/draft-composer.js` | Slate 本文、編集世代、英訳反映、復元。 |
| `extension/styles.css` | Discord 内のボタン、訳文、注意書きの表示。 |
| `extension/service-worker.js` | Chrome の入口、設定、起動、翻訳と保存の配線。 |
| `extension/translation-protocol.js` | 入力・sender・応答検証、固定 prompt、payload、stream。 |
| `extension/translation-provider.js` | 翻訳先の検証・読取り、共有の cache 識別。 |
| `extension/translation-queue.js` | hash 受付順、FIFO、重複排除、購読、期限、メモリ cache。 |
| `extension/received-translation-cache.js` | 受信完成訳の保存、検索、期限、削除、保存エラー。 |
| `extension/bridge-registry.js` | tab の bridge 接続、job 対応、接続待ちと切断。 |
| `extension/bridge.html` / `bridge.js` | 拡張 document の HTTP / SSE と abort。 |
| `extension/chatgpt-native.js` | 固定 host の選択、起動待ちの共有、切替と切断。 |
| `extension/popup.html` / `popup.css` / `popup.js` | 設定、接続管理、有効化の画面と操作。 |
| `scripts/chatgpt-auth.mjs` | OAuth、署名・claims、refresh、認証ファイル、切断。 |
| `scripts/chatgpt-server.mjs` | loopback HTTP 境界、管理ルート、Responses 変換。 |
| `scripts/chatgpt-native-host.mjs` | 共通 Native caller、framing、EOF/signal、ChatGPT 起動。 |
| `scripts/local-native-host.mjs` | local の子プロセス、listener 所有、health、グループ停止。 |
| `scripts/install-native-host.mjs` | macOS 登録、launcher、nvm の Node.js 解決。 |
| `scripts/start-server.sh` | モデル照合、offline 環境、公式 MLX の起動。 |
| `scripts/setup_local.py` | 固定依存の検証、新規 venv への導入、由来の記録。 |
| `scripts/model_assets.py` | モデル台帳、取得、ファイル検証、配置。 |
| `scripts/verify.py` | local API、SSE、生成結果の構造、KV cache、連続要求の検証。 |

## 5. 依存関係

固定指示と検証は `translation-protocol.js` に集約する。
queue は protocol と cache 識別を使い、HTTP を注入された関数へ委譲する。
worker は queue、registry、保存、Native を組み合わせる。
bridge は protocol の payload 形式に対応し、HTTP と SSE を処理する。

ChatGPT 補助は拡張の `buildPayload` と bridge の検証を再利用する。
固定指示の照合と Responses 変換に、別の指示定義を持たない。
Python の検証指示は製品と同じ内容へ同期する。

ローカル HTTP を ChatGPT 補助へ中継しない。
汎用 provider framework、補足専用 API、追加の保存層は設けない。

## 6. データ設計

### 設定と保存

| データ | 配置と寿命 |
| --- | --- |
| `enabled` / `provider` | `chrome.storage.local`。 |
| 受信保存訳 | `chrome.storage.local` の個別キー。有効期間は初回保存から5日。 |
| 共通の完成結果 cache | queue のメモリ。30分、最大256件。 |
| 受信 record と途中訳 | 対象 DOM と有効状態に紐付くメモリ。 |
| 下書きと復元対象 | 同じ入力欄のメモリ。破棄条件で削除する。 |
| ChatGPT 認証 | ユーザ設定ディレクトリ内の保護した JSON ファイル。 |
| ローカル依存 | プロジェクトの `.venv` と導入記録。 |
| ローカルモデル | 台帳と一致する commit 別のファイル群。 |

受信保存はメッセージ ID と共有 cache 識別の hash を組み合わせる。
hash の入力は翻訳先、方向、trim 済み本文、日訳指示版である。
原文の独立した保存項目は持たない。
補足内の原文引用は、完成結果の一部として保存する。

### job と record

queue の job はキー、本文、翻訳先、方向、tab、状態、購読者を持つ。
途中訳は累積文字列で保持する。
受信 record はコンテナ、本文ノード、ID、本文、状態、UI、解除関数を持つ。
下書き record は入力欄、form、パス、世代、復元対象、操作状態を持つ。

<a id="14-受信翻訳専用の永続キャッシュ案2026-10-05"></a>

## 7. インターフェース設計

content の `openTranslationRequest` は payload と通知先を受け取り、解除関数を返す。
受信と下書きは同じ通信関数を使い、表示の判断は各担当で行う。
worker は受信要求の provider を確定し、保存時まで同じ値を使う。
検索は現在選択している provider の保存値を参照する。

bridge registry の `request` は tab、固定 payload、provider、signal、chunk 通知を受け取る。
bridge の応答と content の通知は、別々の Port と検証を使用する。
形式とキーの厳密な条件は仕様書の messaging 節を参照する。

<a id="12-訳文の順次表示2026-10-02"></a>
<a id="23-受信訳のニュアンス補足案-2026-10-27"></a>

## 8. 処理フロー

### 受信翻訳

1. 受信担当が本文を特定し、保存訳を検索する。
2. miss なら利用者の押下を待つ。
3. 要求 Port の sender と入力を worker が検証する。
4. worker が選択先の ready を確認し、queue へ渡す。
5. queue が cache、共有 job、受付上限を確認する。
6. miss の job を FIFO で実行し、固定 payload を bridge へ渡す。
7. bridge が固定先の HTTP / SSE を処理する。
8. queue が累積本文を検証し、購読者へ途中通知する。
9. 完成結果を検証し、メモリ cache と有効な受信要求の保存へ渡す。
10. 受信担当が、現在の DOM と本文に一致する結果を表示する。

補足も同じ文字列として転送する。
注意書きは受信担当が作成し、`[補足]` の有無で `hidden` を更新する。

<a id="13-投稿前の英語翻訳の設計案2026-10-05"></a>

### 下書き翻訳と復元

1. 下書き担当が対応可能な Slate 本文を取得する。
2. 入力欄と編集世代を記録し、英訳を要求する。
3. 完成まで途中訳を無視する。
4. 世代、投稿先、入力欄、元本文を再照合する。
5. paste 相当の入力イベントで完成訳を反映する。
6. 読み戻した Slate 本文の一致を確認し、復元対象を保持する。

「元に戻す」も同じ入力反映処理を使う。
DOM の `textContent` 代入だけで、入力成功と扱わない。

## 9. 状態管理

ON/OFF は content 全体の寿命を決める。
受信本文と下書きは、それぞれ独立した record で状態を持つ。
古い DOM や世代の結果を、現在の対象へ流用しない。

queue の状態は queued、running、完了・失敗、expired とする。
購読解除は通知先を取り除くが、共有 job 自体は取り消さない。
HTTP の期限超過と bridge 切断では、通信の AbortController を終了させる。
受信要求の購読が保存前に閉じていれば、永続保存しない。

Native は選択先ごとの同時接続を増やさず、1つの接続を保持する。
OFF と provider 切替では、サーバ寿命の扱いを分ける。
OFF は接続を維持し、切替は旧 Port を閉じる。

## 10. エラー処理

例外の詳細を UI に渡さず、固定コードへ正規化する。
翻訳の失敗、保存だけの失敗、削除だけの失敗を分ける。
保存失敗でも、検証済みの完成結果は表示する。
自動検索の読込み失敗は手動翻訳への移行を妨げない。

queue、bridge、content、保存処理が、それぞれの期限と資源を解放する。
不完全な SSE や切詰めを、成功へ置き換えない。
別の HTTP 経路への fallback と、無限の翻訳再試行は持たない。

## 11. 並行処理

hash 計算の受付を直列化し、非同期計算で FIFO が逆転しないようにする。
推論は1 job ずつ実行し、同じキーの購読者をまとめる。
provider と翻訳方向が違う job は共有しない。
期限切れ job は通知 timer の実行順だけに依存せず、開始前にも判定する。

受信のストレージ操作は直列化し、項目ごとのキーを更新する。
保存全体を読み戻して置換する方式は使わない。
認証の refresh は共有し、保存は世代照合と直列の atomic rename で行う。
logout 後の遅延処理に、認証を復活させない。

## 12. セキュリティ設計

| 境界 | 制御 |
| --- | --- |
| Discord → worker | 拡張 ID、top frame、Discord origin、tab、入力形式。 |
| worker → bridge | 拡張 ID、子 frame、完全な bridge URL、同一 tab、job ID。 |
| bridge → サーバ | 固定 URL、固定 payload、SSE 検証、有限 timeout。 |
| ブラウザ → ChatGPT 補助 | loopback bind、Host、Origin、固定ヘッダとルート。 |
| 補助 → OpenAI | 固定認証先、固定翻訳指示、検証済み token と完成応答。 |
| Chrome → Native host | 許可拡張、caller 形式、ready framing、任意入力の拒否。 |
| Native → local 子 | 固定スクリプト、所有 listener 確認、所有グループだけの停止。 |
| 依存・モデル → runtime | 固定台帳、全ファイルの照合、コード参照の拒否、取得と起動の分離。 |

CORS は認証ではない。
同一ユーザ権限でコードと台帳を改変する攻撃は、防御範囲外とする。
補足生成は相手の心理の判定手段ではない。
モデルの誤訳や命令風本文への追従を、構造検証だけで防げるとは扱わない。

## 13. ログ・監視

診断は固定コードと構造情報だけにする。
本文、訳文、prompt、認証情報、外部例外の詳細は診断へ流さない。
Native の stdout はプロトコル専用とする。
ローカルの子プロセス出力は Native stdout へ転送しない。

常駐の telemetry、analytics、追加監視サービスは持たない。
検証 CLI と手動の品質確認を使い、実施範囲を区別して記録する。

## 14. テスト容易性

時間、hash、HTTP、storage、Chrome API は既存の注入点と fixture で差し替える。
DOM fixture は Manifest の順序で実 script を読み、公開操作から動作を確認する。
プロセスの試験は一時環境と固定の非機密データを使う。

| 検証 | 主な対象 |
| --- | --- |
| `npm --prefix extension test` | protocol、queue、bridge、content、保存、popup、OAuth、Native host、installer。 |
| `python3 -I scripts/verify.py --self-check` | API 検証 CLI の応答・SSE 解析。 |
| `python3 -I -m unittest discover -s scripts/tests -p 'test_*.py'` | 依存とモデル台帳の検証境界。 |
| 実モデルの固定例 | 意味、補足、識別子、長文、命令風入力。 |
| Chrome 実機 | Discord DOM、編集継続、テーマ、権限、保存復元、Native 寿命。 |

自動テスト、意味評価、実機確認を相互の代用にしない。
検証結果と未確認範囲は `docs/plans/` に記録する。
長期的な判断の根拠は [ADR 一覧](../adr/README.md) を参照する。

## 15. 未決事項

現在の構成を説明するための未決事項はない。
