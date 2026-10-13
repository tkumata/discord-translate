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

ローカル翻訳には Apple Silicon Mac、native arm64 の Python、Google Chrome が必要です。モデルの初回取得にはインターネット接続と、モデルを保存するディスク容量が必要です。

ChatGPT 翻訳には Chrome、Node.js 22 以降、インターネット接続、Sign in with ChatGPT を利用できるアカウントが必要です。MLX とモデルの取得は不要です。2026-10-12にユーザが認証成功を報告し、修正済み補助プログラムと実 API による固定文の日訳・英訳を確認しました。同日のユーザ実機動作確認により、今回の変更の実 Chrome 受け入れは合格しました。

動作確認時の環境は次のとおりです。最低要件を示すものではありません。

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

### 1. Python 環境を作成する

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python -m pip check
```

`requirements.txt` では `mlx-lm==0.31.3` を指定しています。システムの Python 環境にはインストールせず、このプロジェクトの `.venv` を使います。

### 2. モデルを取得する

初回だけ Hugging Face Hub からモデルをダウンロードします。

```bash
HF_HUB_OFFLINE=0 HF_HUB_DISABLE_TELEMETRY=1 \
  ./.venv/bin/mlx_lm.generate \
  --model mlx-community/Qwen3.5-9B-MLX-4bit \
  --prompt 'Translate into Japanese: The build passed.' \
  --max-tokens 8
```

通常起動ではキャッシュ済みモデルをオフラインで読み込みます。モデルの取得が終わっていない場合、サーバは起動できません。

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

別のターミナルから接続を確認できます。

```bash
curl --fail http://127.0.0.1:8080/health
```

`{"status":"ok"}` が返れば HTTP サーバは応答しています。実際にモデルが翻訳できることは、拡張機能または後述の API 検証で確認します。

サーバを停止するには、起動したターミナルで `Ctrl-C` を押します。

## ChatGPT 翻訳のセットアップ

1. 上記「Chrome 拡張機能を読み込む」の手順で `extension/` を読み込み、拡張機能 ID を確認します。更新後は拡張機能と Discord タブを再読み込みしてください。
2. Node.js 22 以降で、次の補助プログラムをリポジトリのルートから起動します。追加の npm パッケージは不要です。

   ```bash
   CORS_ORIGIN="chrome-extension://<拡張機能ID>" node scripts/chatgpt-server.mjs
   ```

3. ポップアップの「翻訳先」で「ChatGPT」を選び、`Continue with ChatGPT` を押します。
4. 開いた OpenAI の認証画面でログインし、ChatGPT の利用枠の使用を許可します。
5. 認証完了後、ポップアップを開き直し、接続済みのアカウントを確認して「有効」を ON にします。

補助プログラムは `127.0.0.1:8766` だけで待ち受けます。使用中はターミナルを開いたままにし、終了は `Ctrl-C` です。認証情報は端末に保存され、次回起動時も利用できます。「切断」は翻訳を OFF にして端末内のトークンを削除し、OpenAI での失効を試みます。失効を確認できなかった場合は、表示された案内に従って ChatGPT の設定でも接続を解除してください。

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

拡張機能と補助プログラムのテストには Node.js 22 以降、および npm が必要です。Node.js のテストは標準のテストランナーを使用し、追加の npm 依存関係はありません。

サーバを起動せずに検証する場合:

```bash
./.venv/bin/python scripts/verify.py --self-check
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
| `scripts/tests/` | 認証・Responses 変換・loopback HTTP の自動テスト |
| `scripts/verify.py` | API 検証とセルフチェック |
| `requirements.txt` | Python の依存関係 |
| `docs/current/` | 要件・仕様・設計 |
| `docs/adr/` | 設計上の決定と理由 |

## 制約

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
| `mlx_lm.server is missing` で起動できない | `.venv` の作成と `requirements.txt` のインストールを行ってください。 |
| モデルを読み込めない | 初回取得が完了しているか、取得時と起動時の `MODEL` が同じか確認してください。 |
| ポップアップで有効化できない | サーバの起動、ポート 8080、拡張機能 ID と `CORS_ORIGIN` の一致、Chrome のローカルネットワーク許可を確認してください。 |
| ChatGPT 用の補助プログラムに接続できない | Node.js 22 以降、ポート 8766、拡張機能 ID と `CORS_ORIGIN` の一致、Chrome のローカルネットワーク許可を確認してください。 |
| `chatgpt_auth_required` | ポップアップから ChatGPT に再接続し、利用枠の使用を許可してください。 |
| `chatgpt_usage_limit` | ポップアップの「ChatGPT の利用量を管理」で利用枠を確認し、利用可能になってから再試行してください。 |
| 認証後の翻訳が `http_error` になる | 2026-10-12に実 API の Content-Type 欠落と最終 output 空配列への対応を追加しました。更新後は補助プログラムを `Ctrl-C` で停止し、同じ起動コマンドで再起動してください。認証情報は維持されます。 |
| 翻訳ボタンが表示されない | 拡張機能と Discord タブを再読み込みし、ポップアップで OFF → ON を試してください。 |
| 翻訳が失敗する | サーバの接続と API 検証結果を確認し、復旧後に「再試行」を押してください。長文の場合は入力を短くして確認してください。 |

## 開発ドキュメント

- [要件定義書](docs/current/REQUIREMENTS.md)
- [仕様書](docs/current/SPECIFICATIONS.md)
- [設計書](docs/current/DESIGN.md)
- [設計上の決定（ADR）](docs/adr/README.md)
