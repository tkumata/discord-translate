# Discord Translator

Discord Web の受信メッセージを日本語へ、投稿前の日本語の下書きを英語へ翻訳する Chrome 拡張機能です。翻訳先はローカル（MLX-LM / Qwen）または ChatGPT を選択できます。ローカルでは本文を端末内で処理し、ChatGPT では Sign in with ChatGPT の同意に基づき本文を OpenAI へ送信し、ChatGPT の利用枠を使います。

## 主な機能

- 各メッセージの「翻訳」ボタンから、必要な本文だけを翻訳します。
- 原文を残したまま、その下に日本語訳を順次表示します。
- 投稿入力欄の「英語に翻訳」で、完成した英語訳を下書きへ反映します。自動投稿は行いません。
- 英語訳は編集できます。「元に戻す」で翻訳前の下書きへ戻せます。
- 翻訳に失敗した場合は、エラー表示と「再試行」ボタンを表示します。
- 拡張機能のポップアップで、全 Discord タブの翻訳機能を ON / OFF にできます。初期状態は OFF です。
- 翻訳先の初期値はローカルです。切り替えると OFF になり、再度 ON にしてから選択先を使います。
- 完成した訳文はメモリ上に最大 256 件・30 分間キャッシュし、同じ本文への重複要求をまとめます。
- 表示された受信メッセージの完成訳は端末内に5日間保存し、ON中は遷移や再読込後に復元します。

対象は Chrome で開く `https://discord.com/` です。Discord デスクトップアプリは対象外です。

## 動作環境

ローカル翻訳の固定環境は macOS 26 以降の Apple Silicon Mac と native arm64 の CPython 3.14 です。Chrome はサポート中の Stable を使います。モデルの初回取得にはインターネット接続と、モデルを保存するディスク容量が必要です。

ChatGPT 翻訳には Chrome、サポート中の Node.js LTS、インターネット接続、Sign in with ChatGPT を利用できるアカウントが必要です。基準の Node.js は 24 LTS です。MLX とモデルの取得は不要です。2026-10-12にユーザが認証成功を報告し、修正済み補助プログラムと実 API による固定文の日訳・英訳を確認しました。同日のユーザ実機動作確認により、当時の変更の実 Chrome 受け入れは合格しました。

過去のユーザ実機確認時の環境は次のとおりです。最低要件を示すものではありません。2026-10-14 の固定環境による検証結果は実装計画に記録しています。

| 項目 | 動作確認環境 |
| --- | --- |
| ハードウェア | Apple M4、メモリ 24 GB |
| OS | macOS 26.6.2（arm64） |
| Python | 3.14.7（native arm64） |
| 推論ランタイム | MLX-LM 0.31.3、MLX 0.32.0 |
| モデル関連ライブラリ | Transformers 5.15.0 |
| モデル | `mlx-community/Qwen3-8B-4bit` |
| ブラウザ | Google Chrome（バージョンの記録なし） |

この環境でローカル API の起動・停止・再起動と、Chrome 上での手動翻訳・訳文の順次表示を確認しています。Intel Mac、Windows、Linux、他のブラウザでの動作は確認していません。

## ローカル翻訳のセットアップ

以下のコマンドはリポジトリのルートで実行します。

### 1. 固定した Python 依存を導入する

信頼した配布元の Python 3.14 を使います。実行ファイルの取得元を確認し、`--python-source` に記録してください。Homebrew で導入した場合の例を示します。

```bash
git rev-parse HEAD
git status --short
python3.14 -I scripts/setup_local.py --python-source 'Homebrew python@3.14'
```

`requirements.txt` は全 34 依存の版と対象 wheel の SHA-256 を固定しています。導入処理は PyPI だけを使い、pip の環境変数と設定ファイルによる配布元の上書きを遮断します。hash 不一致、未固定依存、対応 wheel 不足はエラーになります。source build、追加 index、自動的な代替取得は行いません。

導入処理は Python に同梱された `ensurepip` で pip を初期化します。取得元、Python と pip の版、Git commit、未コミット変更の有無、依存台帳の hash を `.venv/supply-chain-install.json` に記録します。記録は署名による由来の証明ではありません。ソースと台帳は信頼した commit と照合してください。

既存の `.venv` は上書きしません。移行時は既存のローカルサーバを停止し、`.venv` を未使用の `.venv-before-supply-chain` 等へ退避してから、同じコマンドを実行してください。移動した venv は移動先で使わず、復旧時に元の `.venv` の位置へ戻します。失敗した新規 venv も再利用しません。別の新規ディレクトリで検証する場合は `--venv <新規パス>` を指定します。

### 2. モデルを取得する

初回だけ Hugging Face Hub から、`models.lock.json` の commit に固定したモデルを取得します。

```bash
./.venv/bin/python -I scripts/model_assets.py fetch
```

既存キャッシュを再利用する場合は、固定 snapshot のファイルをコピーしてから照合します。

```bash
./.venv/bin/python -I scripts/model_assets.py fetch --from-cache \
  "$HOME/.cache/huggingface/hub/models--mlx-community--Qwen3.5-9B-MLX-4bit/snapshots/938d8919941c6e7efd3c7150eff7fe9d12afa631"
```

取得処理は台帳の 11 ファイルだけを `models/` に保存します。全ファイルの検証後に配置を確定します。通常起動でも全ファイルの SHA-256 と設定を検証し、検証済みの絶対ローカルパスを公式サーバへ渡します。通常起動はモデル取得と依存導入を行いません。不足・改変・余分なファイル・モデル領域外への symlink は起動失敗になります。

重みは safetensors に限定します。起動前の検証は `model_file`、`auto_map` と custom tokenizer 指定を拒否します。MLX CLI のフラグ省略は明示的な `trust_remote_code=False` ではないため、データと組込み実装の限定によってモデル由来のコード読込みを禁止します。標準入力は `/dev/null` とし、対話による許可も行いません。

### 3. Chrome 拡張機能を読み込む

1. Chrome で `chrome://extensions` を開き、「デベロッパー モード」を有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」を選び、このリポジトリの `extension/` ディレクトリを指定します。
3. 表示された拡張機能 ID をコピーします。ID は `a`〜`p` の 32 文字です。

### 4. 翻訳サーバを起動する

次の `<拡張機能ID>` を、Chrome に表示された実際の ID に置き換えて実行します。

```bash
export MODEL=mlx-community/Qwen3.5-9B-MLX-4bit
export PORT=8080
export CORS_ORIGIN="chrome-extension://<拡張機能ID>"
./scripts/start-server.sh
```

サーバは `127.0.0.1:8080` で待ち受けます。拡張機能の接続先もこのアドレスに固定されているため、拡張機能と使う場合は `PORT=8080` にしてください。CORS には上記の拡張機能 ID を指定し、`*` や `https://discord.com` は指定しません。

`MODEL` は台帳に登録したモデルの選択だけに使います。任意の Hub 名やパスは拒否します。モデルファイルの起動前照合は、この環境の約 6 GB のモデルで約 2.2 秒でした。

別のターミナルから接続を確認できます。

```bash
curl --fail http://127.0.0.1:8080/health
```

`{"status":"ok"}` が返れば HTTP サーバは応答しています。実際にモデルが翻訳できることは、拡張機能または後述の API 検証で確認します。

サーバを停止するには、起動したターミナルで `Ctrl-C` を押します。

## ChatGPT 翻訳のセットアップ

1. 上記「Chrome 拡張機能を読み込む」の手順で `extension/` を読み込み、拡張機能 ID を確認します。更新後は拡張機能と Discord タブを再読み込みしてください。
2. macOS とサポート中の Node.js LTS で、Native Messaging を一度登録します。リポジトリと Node の取得元を確認し、`git rev-parse HEAD`、`git status --short`、`command -v node` と `node --version` を確認してください。登録は表示した Node とソースの絶対パスを実行対象にします。リポジトリのルートから次を実行してください。追加の npm パッケージは不要です。

   ```bash
   node scripts/install-native-host.mjs <拡張機能ID>
   ```

3. 手動で起動していた ChatGPT 補助プログラムがあれば `Ctrl-C` で停止し、`chrome://extensions` で拡張機能を再読み込みします。ポップアップの「翻訳先」で「ChatGPT」を選び、`Continue with ChatGPT` を押します。
4. 開いた OpenAI の認証画面でログインし、ChatGPT の利用枠の使用を許可します。
5. 認証完了後、ポップアップを開き直し、接続済みのアカウントを確認して「有効」を ON にします。

登録後は拡張機能の読み込みと Chrome のプロファイル起動時に補助プログラムが自動起動します。翻訳の ON / OFF や翻訳先に関係なく起動し、ターミナルを開いておく必要はありません。待ち受けは `127.0.0.1:8766` だけです。Native 接続が終了すると補助も停止します。Chrome を完全終了するか、拡張機能を無効化すると接続が終了します。Chrome ウィンドウを閉じただけでは終了しない場合があります。

起動に失敗した場合は無限に再起動せず、ポップアップで ChatGPT の操作をするか、翻訳を依頼したときに再試行します。手動起動との併用や複数 Chrome プロファイルでの同時使用はできません。二重起動は認証情報を読み書きする前に拒否します。

登録は `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` に本拡張専用の JSON と起動用 shell script を保存し、指定の拡張機能 ID だけを許可します。Node とリポジトリの絶対パスを使うため、Node の移動・削除やリポジトリの移動、拡張機能 ID の変更後は同じ登録コマンドを再実行してください。自動起動を解除するには、このディレクトリの `com.discord_translate.chatgpt.json` と `com.discord_translate.chatgpt.sh` を削除します。

登録先は同じ Chrome の全プロフィールで共有されます。許可はプロフィール名ではなく拡張機能 ID で制限します。同じ ID の拡張を複数プロフィールに読み込んだ場合はどちらも起動を試み、固定ポートで競合します。

2026-10-13、ユーザが手動補助の停止後に対象プロフィールと拡張を読み込み、翻訳動作と Native host のプロセスを実機で確認しました。自動テスト101件とユーザの実機確認を根拠に、本変更の受け入れは合格し、開発を完了しています。

認証情報は端末に保存され、次回起動時も利用できます。「切断」は翻訳を OFF にして端末内のトークンを削除し、OpenAI での失効を試みます。失効を確認できなかった場合は、表示された案内に従って ChatGPT の設定でも接続を解除してください。

API key は不要です。[ChatGPT の利用量設定](https://chatgpt.com/settings/usage)で利用枠を確認できます。利用可能なモデル一覧から最初の表示対象を使います。ChatGPT の会話画面、履歴、メモリとは連携しません。認証と推論の方式は [公式の Sign in with ChatGPT 文書](https://developers.openai.com/siwc/quickstart)に従います。

## 使い方

1. Chrome で Discord Web を開きます。
2. 拡張機能のポップアップを開き、セットアップ済みの翻訳先を選んで「有効」を ON にします。
3. Chrome がローカルネットワークへのアクセス許可を求めた場合は、許可します。サーバへの接続確認に成功すると ON になります。
4. 翻訳したいメッセージの「翻訳」を押します。
5. 原文の下に「日本語訳（翻訳中…）」が表示され、生成が終わると「日本語訳」に変わります。

有効化しただけでは新しい翻訳を依頼しません。保存済みの受信訳文は、メッセージIDと原文が一致した場合だけ復元します。失敗した場合は途中の訳文を除去し、原文を残して「再試行」を表示します。OFF にすると、拡張機能が追加したボタン・訳文・エラー表示を取り除きます。OFFでも保存済みの受信訳文は期限内まで保持します。

保存期間は初回保存から120時間です。復元では期限を延長しません。期限切れデータは復元せず、次のworker起動または保存操作で削除します。

ローカルと ChatGPT のキャッシュは分離しています。切り替えると表示中の訳文と進行中の購読を取り除き、下書き本文は保持します。翻訳失敗時に翻訳先を自動変更しません。

投稿前に英語へ翻訳する場合:

1. チャンネル、DM、スレッドの投稿入力欄に日本語で下書きを書きます。
2. 入力欄の近くの「英語に翻訳」を押します。
3. 翻訳が完了すると、入力欄の下書きが英語へ置き換わります。
4. 英語訳を確認・編集してから、Discordの通常の操作で投稿します。
5. 日本語へ戻したい場合は、投稿前に「元に戻す」を押します。

「元に戻す」は翻訳直前の空白・改行も復元します。英語訳に加えた編集は置き換わります。投稿、入力欄の空化、投稿先移動、入力欄交換、OFFでは復元対象を破棄します。翻訳中に下書きを編集した場合は、古い翻訳結果を反映しません。

下書き翻訳は自動テストと実モデル確認済みです。Discord実画面での新機能も、2026-10-05のユーザ実機確認により意図どおりと確認されています。

## 通信とデータの扱い

ローカル翻訳は、Chrome 拡張機能から同じ Mac 上の `http://127.0.0.1:8080/v1/chat/completions` へ送信します。MLX サーバは loopback のみで待ち受け、通常起動では Hugging Face Hub への接続と telemetry を無効にします。

ChatGPT 翻訳は `http://127.0.0.1:8766` の補助プログラムを経由し、OAuth による認証情報で公開 Responses API を呼び出します。手動で翻訳を依頼した本文と固定の翻訳指示を送信します。補助プログラムに本文の保存機能はなく、API には `store:false` を指定します。OpenAI 側でのデータの扱いはサービスの条件に従います。

拡張機能の `chrome.storage.local` には ON / OFF、翻訳先と受信メッセージの完成訳を保存します。完成訳にはメッセージID、原文のハッシュ、保存時刻、失効時刻を対応付けます。原文、下書き、投稿用の英語訳、途中訳、失敗結果は永続保存しません。保存した訳文をChromeの同期領域や外部サービスへ送信しません。投稿用の翻訳を含む既存の30分のメモリキャッシュは維持します。

ChatGPT のトークンは Chrome の保存領域へ渡さず、`~/.config/discord-translate/chatgpt.json` に保存します。directory は所有者のみアクセス可能（0700）、file は所有者のみ読み書き可能（0600）とします。このファイルを共有・同期しないでください。切断後も端末 ID と登録済みアカウントとの対応は保持し、再接続で再利用します。複数アカウントの切り替え UI はありません。

保存領域の標準上限は10MBです。有効な保存訳は容量不足でも早期削除しません。新しい保存に失敗した場合は、完成訳を残して「翻訳文を保存できませんでした（cache_write_failed）」と通知します。保存できなかった訳文は5日間の保持を保証できません。読込み失敗は `cache_read_failed`、期限切れデータの削除失敗は `cache_cleanup_failed` で通知します。

MLX サーバのログ設定は `CRITICAL` とし、通常のログに本文・訳文を出力しません。補助プログラムも本文・訳文・トークンをログへ出力しません。補助プログラムは Host、ブラウザの Origin、専用ヘッダを検証します。同じ端末上のプロセスに対する認証ではありません。

## 開発環境と検証

サーバには公式の `mlx_lm.server` を使い、起動スクリプトは Bash、API 検証スクリプトは Python 標準ライブラリで実装しています。拡張機能は Manifest V3 と JavaScript / HTML / CSS で構成され、ビルドは不要です。

拡張機能と補助プログラムのテストにはサポート中の Node.js LTS、および npm が必要です。基準環境は Node.js 24 LTS です。Node.js のテストは標準のテストランナーを使用し、追加の npm 依存関係はありません。`npm install` と `npx` は不要です。導入・モデル検証のテストは Python 標準の unittest を使います。

サーバを起動せずに検証する場合:

```bash
./.venv/bin/python scripts/verify.py --self-check
./.venv/bin/python -I -m unittest discover -s scripts/tests -p 'test_*.py'
npm --prefix extension test
```

実モデルを使って API、ストリーミング応答、CORS、入力 KV キャッシュの再利用、直列要求を検証する場合は、サーバを起動したまま別のターミナルで実行します。`<拡張機能ID>` は実際の ID に置き換えてください。

```bash
./.venv/bin/python scripts/verify.py \
  --origin "chrome-extension://<拡張機能ID>" \
  --streaming \
  --count 20
```

検証スクリプトは固定のテスト文を使い、本文・訳文を出力・保存しません。Chrome での表示や操作は、実際の Discord Web 上でも確認してください。

主なファイルとディレクトリ:

| パス | 内容 |
| --- | --- |
| `extension/` | Chrome 拡張機能 |
| `extension/content-script.js` | 設定・observer・bridgeの起動と終了 |
| `extension/received-messages.js` / `draft-composer.js` | 受信翻訳と投稿前英訳の独立した状態・UI |
| `extension/request-client.js` | content側のPort通信と固定応答検証 |
| `extension/service-worker.js` | Chrome入口と翻訳・保存処理の配線 |
| `extension/translation-protocol.js` | 入力・固定payload・stream・最終応答の契約 |
| `extension/translation-queue.js` / `bridge-registry.js` | 共有ジョブ・cacheとtab別Port接続 |
| `extension/tests/` | 拡張機能の自動テスト |
| `scripts/start-server.sh` | ローカル推論サーバの起動 |
| `scripts/chatgpt-server.mjs` / `chatgpt-auth.mjs` | ChatGPT 翻訳用の補助プログラムと認証 |
| `scripts/chatgpt-native-host.mjs` / `install-native-host.mjs` | Native Messaging による起動・停止と macOS 登録 |
| `scripts/tests/` | 認証・Responses 変換・loopback HTTP の自動テスト |
| `scripts/verify.py` | API 検証とセルフチェック |
| `requirements.txt` | Python の依存関係 |
| `models.lock.json` | 許可モデルの commit、ファイル名、サイズと SHA-256 |
| `scripts/setup_local.py` | 新規 venv への hash 検証付き依存導入と取得元の記録 |
| `scripts/model_assets.py` | モデルの固定取得、既存キャッシュ移行、起動前の検証 |
| `docs/current/` | 要件・仕様・設計 |
| `docs/adr/` | 設計上の決定と理由 |

## 制約

- サプライチェーン対策は完全な安全性を保証しません。初回採用時の悪意、配布元や OS の侵害、parser の欠陥は残存リスクです。
- 公式 MLX サーバは基本的なセキュリティ検査だけを提供します。起動前の検証はサーバ API を変更しません。同一端末の別プロセスからの任意 HTTP 要求を排除する境界ではありません。
- CSP は拡張機能のページと worker に適用します。同梱 script と固定 loopback 接続だけを許可します。Native host と Discord 本体には適用しません。

- 翻訳品質はモデルと入力に依存します。Markdown、URL、コードなどの保持を指示していますが、完全な保持は保証しません。重要な内容は原文と照合してください。
- 入力は 8,000 UTF-16 コード単位までです。ローカル出力は最大 1,024 トークンです。ChatGPT にはこのトークン設定を渡さず、共通の出力検証上限 64 Ki UTF-16 コード単位を適用します。途中で切れた応答は失敗とします。
- 翻訳要求は 1 件ずつ処理します。待機と実行にはそれぞれ 120 秒の上限があり、要求が集中すると待ち時間やエラーが発生します。
- Discord の画面構造の変更により、翻訳ボタンが表示されなくなる場合があります。
- 下書き翻訳は通常の投稿入力欄のテキストを対象とします。メンションなどの非テキスト要素を含む下書きは翻訳しません。投稿済みメッセージの編集欄や検索欄は対象外です。
- Discordが入力欄の更新を受理しない場合は「下書きを更新できませんでした」と表示します。
- サーバの自動起動は提供していません。利用時に起動スクリプトを実行してください。

## トラブルシューティング

| 症状 | 確認すること |
| --- | --- |
| `mlx_lm.server is missing` で起動できない | 新規 venv に対して `scripts/setup_local.py` を実行してください。 |
| `model_verification_failed` で起動できない | `scripts/model_assets.py verify` で確認し、台帳と取得物を照合してください。改変済みの配置を自動上書きせず、退避してから取得します。 |
| `venv_already_exists_use_a_new_directory` | 既存サーバを停止し、既存 venv を退避するか `--venv` に未使用パスを指定してください。 |
| ポップアップで有効化できない | サーバの起動、ポート 8080、拡張機能 ID と `CORS_ORIGIN` の一致、Chrome のローカルネットワーク許可を確認してください。 |
| ChatGPT 用の補助プログラムに接続できない | Native Messaging の登録を再実行し、拡張機能を再読み込みしてください。サポート中の Node.js LTS、ポート 8766 の競合、登録した拡張機能 ID、Chrome のローカルネットワーク許可を確認してください。 |
| `chatgpt_auth_required` | ポップアップから ChatGPT に再接続し、利用枠の使用を許可してください。 |
| `chatgpt_usage_limit` | ポップアップの「ChatGPT の利用量を管理」で利用枠を確認し、利用可能になってから再試行してください。 |
| 認証後の翻訳が `http_error` になる | 2026-10-12に実 API の Content-Type 欠落と最終 output 空配列への対応を追加しました。更新後は拡張機能を再読み込みし、補助を再起動してください。認証情報は維持されます。 |
| 翻訳ボタンが表示されない | 拡張機能と Discord タブを再読み込みし、ポップアップで OFF → ON を試してください。 |
| 翻訳が失敗する | サーバの接続と API 検証結果を確認し、復旧後に「再試行」を押してください。長文の場合は入力を短くして確認してください。 |

## 開発ドキュメント

- [要件定義書](docs/current/REQUIREMENTS.md)
- [仕様書](docs/current/SPECIFICATIONS.md)
- [設計書](docs/current/DESIGN.md)
- [設計上の決定（ADR）](docs/adr/README.md)

## 依存関係とモデルの更新

通常起動とは別に、管理者が次の順序で更新します。新しいモデルの採用は既存の実装計画の範囲に含めません。

1. 信頼した Git commit、Python 配布元、Node.js 配布元を確認します。
2. 配布者の公式情報で、EOL、非推奨指定、公開セキュリティ勧告を確認します。月次の確認も行います。
3. Python は新規 venv で全依存を解決します。PyPI の正規プロジェクトと選択した wheel を確認し、SHA-256 を `requirements.txt` へ記録します。source distribution は採用しません。
4. モデルは完全な commit ID と許可ファイルを確認します。LFS 資産の SHA-256 と通常ファイルの Git blob ID を固定元の情報と照合し、各ファイルの SHA-256 とサイズを `models.lock.json` へ記録します。
5. バージョン、配布者、追加依存、対象ファイルとハッシュの差分をレビューします。取得直後のハッシュ生成だけでは、安全性の確認になりません。
6. 新規 venv への正式導入、モデル検証、異常系テスト、両翻訳先の回帰検証を行います。自動検証と実 Chrome の確認は分けて記録します。
7. 検証後に台帳を採用します。直前の信頼した commit、モデル資産、venv の復旧先を保持します。既知の危険がある旧版へ戻す操作は安全な復旧とは扱いません。

2026-10-14 の採用確認では、34 依存の対象 wheel と PyPI の公表ハッシュが一致しました。対象版について PyPI と OSV の公開脆弱性情報に該当はありませんでした。公開情報に未掲載の問題がないことは保証しません。

詳細は [ADR-011](docs/adr/011-verified-dependency-and-model-inputs.md) と [実装計画](docs/plans/active/2026-10-14-supply-chain-hardening.md) を参照してください。

2026-10-14、ユーザの動作確認完了報告に基づき、今回の実 Chrome 受け入れを合格とし、開発を完了しました。個別操作と異常系の実機試験内訳は未報告です。
