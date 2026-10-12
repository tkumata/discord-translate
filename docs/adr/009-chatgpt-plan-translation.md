# ADR-009 ローカル翻訳と ChatGPT の利用枠による翻訳を選択する

## Status

Accepted — 2026-10-12 にユーザが文書作成後の実装を承認した。
実装済み。2026-10-12のユーザ実機確認により実 Chrome の受け入れは合格し、本変更を完了した。
ADR-001、002、004、005、008 のローカル専用条件に例外を設ける。
既存 ADR の履歴は上書きしない。

## Context

利用者はローカルと ChatGPT を選んで翻訳したい。
Sign in with ChatGPT は利用枠による Responses API 呼出しを提供する。
公開認証方式は HTTP loopback の callback listener を必要とする。
現在の拡張は公式 MLX サーバだけに接続する。
現在のローカル翻訳を独自サーバへ移す必要はない。

## Decision

- MUST: 翻訳先を `local` / `chatgpt` とし、初期値は `local` とする。
- MUST: ChatGPT の本文送信と利用枠の消費を popup に明示する。
- MUST: 翻訳操作でだけ本文を送信し、自動翻訳を追加しない。
- MUST: ChatGPT 失敗時に翻訳先を自動変更しない。
- MUST: Node.js 標準機能のローカル補助プログラムを追加する。
- MUST: 補助プログラムは `127.0.0.1:8766` だけで待ち受ける。
- MUST: 拡張は固定 loopback URL のみを使用する。
- MUST: 補助プログラムが認証、保管、更新、外部通信を所有する。
- MUST: tokens は保護された端末内ファイルだけに保存する。
- MUST: Chrome storage と通常ログに tokens を渡さない。
- MUST: state、PKCE、nonce、JWT 署名と claims を検証する。
- MUST: 認証世代と直列保存で切断後の認証復活を防ぐ。
- MUST: 固定翻訳 prompt だけを受け付け、汎用 API proxy にしない。
- MUST: Responses の正常完了を検証して既存 SSE へ変換する。
- MUST: queue と受信保存訳を翻訳先別に区別する。
- MUST: ローカルの既存保存訳を期限内まで保持する。

ブラウザ由来の API は設定した拡張 origin だけに CORS を許可する。
Host を固定し、通常 API は独自 header を必須とする。
Origin がある場合は完全一致を要求する。`null` は拒否する。
callback と login の GET は期限付き認証試行で照合する。
同機の他プロセスを排除する認証境界とは扱わない。

## Alternatives

- 拡張だけで認証する: 公開方式の loopback listener を実装できない。
- MLX の前に統合 proxy を置く: ローカルにも補助起動が必要になる。
- OpenAI API key を使う: 利用者が希望するサインイン方式と異なる。
- Codex を翻訳実行に使う: 翻訳に不要な実行環境を増やす。

## Consequences

ローカル時は現在の MLX サーバだけを使う。
ChatGPT 時は補助プログラムを起動し、MLX の起動を不要にする。
追加 npm / Python package、framework、build 工程は導入しない。
アカウントは1接続を扱う。複数アカウント UI は追加しない。
利用可能モデル一覧の先頭の表示対象モデルを使用する。
ChatGPT の会話履歴やメモリへのアクセスは提供しない。
切断は認証情報を削除し、可能な場合は renewable session を失効する。
失効を確認できない場合は ChatGPT 設定での切断を案内する。
実アカウントと Chrome の確認は自動検証と区別する。

## References

- [認証](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [更新・切断](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [推論](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [制約](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [利用条件](https://openai.com/policies/sign-in-with-chatgpt-terms/)
- [実装計画](../plans/active/2026-10-12-chatgpt-translation.md)
