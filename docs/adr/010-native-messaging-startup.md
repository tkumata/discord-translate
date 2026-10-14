# ADR-010 Native Messaging で ChatGPT 補助を起動する

## Status

Accepted — 2026-10-13 にユーザが Native Messaging 方式を選択した。
実装・Node 自動検証済み。2026-10-13のユーザ実機確認により本変更の受け入れは合格し、ユーザの指定により開発を完了した。
ADR-009 の手動起動と API permission 非追加の条件を本判断で拡張する。
2026-10-14、翻訳先に関係なく補助を維持する条件は [ADR-012](012-provider-specific-server-startup.md) の選択先別起動で更新した。以下は採用時の履歴である。

## Context

Chrome 拡張の起動時に ChatGPT 補助を自動起動し、ターミナルでの手動起動を不要にする。
拡張からシェルコマンドを直接実行できないため、Chrome が起動する Native Messaging host を使う。

## Decision

- `nativeMessaging` permission と固定 host 名 `com.discord_translate.chatgpt` を追加する。
- worker 読み込みと `runtime.onStartup` で Native Port に接続する。
- 翻訳の ON / OFF、provider 切替、アカウント切断では Native Port を閉じない。OFF でも認証操作に補助が必要である。
- Native host は同じプロセスで既存の HTTP サーバ起動処理を再利用する。
- caller origin は Chrome の引数から取得し、登録した拡張だけを `allowed_origins` で許可する。
- Node と host の絶対パスを macOS ユーザ用登録に保存する。新しい依存関係は追加しない。
- Native メッセージは host からの起動完了 `{type:"ready"}` だけとし、受信データは拒否する。任意コマンド・URL・本文・tokens を渡さない。
- 起動完了は15秒以内に確認する。popup の ChatGPT HTTP 操作と worker の ChatGPT 翻訳要求は完了を待つ。
- popup からの起動確認は同じ拡張 ID と正確な popup URL のみ許可し、tab 由来の要求を拒否する。
- EOF、SIGINT、SIGTERM では進行中の要求を abort し、HTTP listener と接続を閉じる。
- 起動失敗・異常切断は自動再起動ループを作らず、次の ChatGPT 操作で再試行する。
- `127.0.0.1:8766` の bind 成功前に認証へ触れない。競合プロセスを停止・引き継ぎしない。

## Alternatives

- LaunchAgent: ログイン起動となり、ユーザが希望する拡張起動との連動にならない。
- 翻訳・認証も Native メッセージへ移す: 既存 HTTP/bridge の変更が不要なため採用しない。

## Consequences

macOS の初回登録が必要になる。登録後は Chrome が補助のプロセスを管理する。
Native Port により worker を維持する。local 使用中も ChatGPT 補助は起動するが、自動翻訳や OpenAI への本文送信は追加しない。
複数プロファイルの同時起動と手動補助の併用は固定ポートで競合する。
macOS ユーザ用登録先は同じ Chrome の全プロフィールで共有する。`allowed_origins` は拡張 ID による許可であり、プロフィール名を識別しない。同じ ID を複数プロフィールへ読み込むと、両方が起動を試みる。
拡張無効化・Chrome 完全終了で停止する。ウィンドウを閉じる操作だけでは Chrome が終了しない場合がある。
Node、リポジトリの場所や拡張 ID が変わった場合は再登録する。
認証、CORS、loopback、SSE、queue、cache の所有境界を維持する。

## References

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
