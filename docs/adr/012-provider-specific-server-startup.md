# ADR-012 選択した翻訳先のサーバを拡張から起動する

## Status

Accepted — 2026-10-14、ユーザが提示範囲を承認した。
実装・自動テスト111件・実モデルでの起動停止を確認済み。同日のユーザ実機確認完了報告に基づき、本変更の実 Chrome 受け入れを合格とし、完了した。個別操作と異常系の実機試験内訳は未報告。
ADR-010 の翻訳先に関係なく ChatGPT 補助を維持する判断を、本 ADR で更新する。

## Context

ChatGPT 補助は既に Native Messaging で起動できるが、ローカル翻訳は手動起動である。
拡張起動時と翻訳先切替時に、選択先のサーバだけを起動する。
ローカルのモデル照合・offline・loopback・CORS の所有者は `start-server.sh` のままにする。

## Decision

- Native host を固定した `com.discord_translate.local` / `com.discord_translate.chatgpt` に分け、既存 installer で両方を登録する。
- worker が保存済み provider を読み、対応する一つの Native Port を維持する。OFF とアカウント切断では停止しない。
- provider 変更で旧 Port を閉じ、新しい選択先を起動する。遅れた設定読取りは新しい選択を上書きしない。
- popup の起動確認は同一拡張の正確な popup URL に限定し、保存済み provider との一致も要求する。任意 host・コマンドを指定させない。
- local host は Chrome の caller origin を検証し、絶対パスの `scripts/start-server.sh` を起動する。既存の固定モデルとポート8080を指定し、CORS は caller から設定する。
- ローカル子プロセスを独立したプロセスグループにし、起動途中のモデル検証も停止対象にする。stdout/stderr は Native stdout に転送しない。
- ローカル起動は120秒以内に、子プロセスがポート8080の listener を所有することと厳密な `/health` 応答を確認する。所有確認には macOS 標準の `/usr/sbin/lsof` を使う。
- Native ready 待機は ChatGPT が15秒、local が停止処理の余裕を含め130秒とする。popup の有効化と両翻訳先への要求は ready を待つ。
- EOF・signal・切替で自分が起動したサーバを停止する。ローカルのプロセスグループへ SIGTERM を送り、1秒で終了しなければ SIGKILL を送る。
- ローカル子プロセスが ready 後に終了した場合も Native 接続を閉じる。異常終了・競合・timeout は成功扱いせず、次の操作でだけ再試行する。
- 既存の手動サーバや別プロフィールのサーバを停止・引継ぎしない。新しい依存・権限・モデル取得・自動翻訳は追加しない。

## Consequences

既存利用者も Native host の再登録が必要になる。リポジトリ、Node、拡張 ID の変更後も再登録する。
ローカルの依存と検証済みモデルは事前に準備する。起動失敗時に翻訳先を自動変更しない。
Chrome 完全終了・拡張無効化で Native 接続が終わる。ウィンドウを閉じるだけでは終了しない場合がある。
固定ポートの複数プロフィール同時使用は引き続き対象外とする。
翻訳 HTTP、認証、queue、cache、保存の既存境界を維持する。

## References

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Node.js child process](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
- [Chromium macOS process termination](https://chromium.googlesource.com/chromium/src/+/main/base/process/kill_mac.cc)
- [実装・検証記録](../plans/active/2026-10-14-provider-server-startup.md)
