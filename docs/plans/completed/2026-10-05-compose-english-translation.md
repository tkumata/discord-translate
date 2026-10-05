# Discord投稿前の英語翻訳

## Status

- Phase: completed
- Approval: approved（2026-10-05「OK, 実装してください。」）
- 実装・自動検証・実モデル検証は完了。
- 実Chromeの機能受け入れは2026-10-05のユーザ実機確認で合格。
- 既存の受信メッセージ翻訳の承認・検証状態は維持する。
- 英語訳の下書き反映、編集継続、「元に戻す」はユーザ指定で確定した。
- 2026-10-05: 実Chromeを使わず実装・自動テストを先に行う方針を承認済み。
- ユーザ報告: 「こちらで実機確認しました。新規に追加した機能は意図とおりです。」
- エージェントによる実Chrome操作は未実施である。
- 個別の異常系・画面別の実機試験内訳は未報告である。

## Goal

利用者はDiscord Webで日本語の下書きを書く。
利用者は「英語に翻訳」を押して英語へ変換する。
英語訳は未投稿の下書きとして残る。
利用者は英語訳を確認・編集してから、自分で投稿する。
利用者は「元に戻す」で翻訳前の日本語の下書きへ戻せる。

## Scope

- 通常の新規投稿入力欄に「英語に翻訳」を追加する。
- 初期対象はチャンネル、DM、スレッドのテキスト下書きとする。
- 最終検証済みの英語訳で同じ入力欄を置き換える。
- 「元に戻す」で翻訳直前の下書き全体を復元する。
- 既存Port、workerのqueue/cache、bridge、モデルを再利用する。
- 翻訳先を固定promptと共有job/cacheのkeyへ反映する。
- 仕様の同期、動作テスト、実モデル・実Chrome確認を行う。

初期対象は2026-10-05のユーザ承認範囲に含まれる。
主な変更候補は次のファイルとする。

- `extension/content-script.js`
- `extension/styles.css`
- `extension/service-worker.js`
- `extension/tests/content-script.test.js`
- `extension/tests/service-worker.test.js`
- `docs/current/PRD.md`、`REQUIREMENTS.md`、`SPECIFICATIONS.md`、`DESIGN.md`
- `README.md`の使い方と対象範囲

## Non-goals

- 拡張機能によるDiscordへの投稿
- 入力中の自動翻訳と入力欄への部分訳の書き込み
- 言語選択、英語以外への下書き翻訳
- メンションなどの非テキスト要素の書き換え
- 投稿済みメッセージの編集欄、検索欄への対応
- 添付ファイルの操作
- 新しい依存関係、権限、サーバ、モデル、HTTP経路
- 複数世代の下書き履歴、下書きの永続保存

## Required Behavior

- MUST: ボタン押下時だけ日本語の下書きを英語へ翻訳する。
- MUST: 翻訳後も英語訳を未投稿の下書きとして残す。
- MUST: 生成中と失敗時は下書きを変更しない。
- MUST: 編集、移動、入力欄交換、OFF後の結果を適用しない。
- MUST: Discordの編集状態へ英語訳を反映する。
- MUST: 「元に戻す」で翻訳直前の日本語の下書きへ戻せる。
- MUST: 翻訳先が異なるjobとcacheを共有しない。
- MUST: 既存の受信メッセージ翻訳とprivacy境界を維持する。

REQ-F-018〜025、AC-019〜025、SPEC-COMPOSE-001〜005を適用する。
MUSTは必須要求を表す。

## Tasks

### Task 1: Discord入力欄の安全な更新方法を確認する

- Status: 完了。実Chromeでの機能受け入れはユーザ確認で合格。
- 確認結果:
  - `cua.getState()`で操作可能なbrowserは0件だった。
  - Chromeへの接続は`Browser is not available: chrome`で失敗した。
  - エージェントの調査時点では実Discord入力欄の識別・反映・復元は未確認だった。
  - 標準の`beforeinput`、`DataTransfer`、`StaticRange`を選定した。
  - Slateの公開ソースで編集イベントとtarget rangeの処理を確認した。
  - 自動テストでは独立した編集モデルへ反映するイベントを検証した。
  - 実装後のユーザ実機確認により、新機能が意図どおりと報告された。
- Objective: 下書きの反映・編集継続・復元を実装できる方法を確認する。
- Scope:
  - 公開資料で対象入力欄の識別、テキスト抽出、編集反映を調査する。
  - 改行、下書きの復元、非テキスト要素、添付ファイルの境界を確認する。
  - SPEC-COMPOSE-001、003、005とDESIGN第13節へ結果を記録する。
- Acceptance Criteria:
  - チャンネル、DM、スレッドの対象入力欄を区別できる。
  - 非機密の下書きを更新しても投稿は発生しない。
  - Discordの編集状態へ更新が反映され、編集を続けられる。
  - 翻訳前の下書きへ戻した後も編集できる。
  - 非対応入力は変更せず、添付ファイルを保持する。
- Verification:
  - 実装方法を自動テストで検証する。
  - 認証済みDiscord Webでの手動確認は実装後の未検証項目へ分離する。
  - 投稿操作は実行しない。
  - 範囲拡大が必要な場合は仕様を更新して再承認を得る。

### Task 2: 固定英語promptと翻訳先別のjob/cacheを追加する

- Status: 実装・自動/実モデル検証完了。
- Result:
  - 既存要求は日本語訳、新しい`translateDraft`要求は英語訳とした。
  - 翻訳先を含むkeyで共有jobとcacheを分離した。
  - 英訳3ケースと既存の日本語訳1ケースが実モデルで成功した。
  - 本文と訳文は検証ログへ出力・保存していない。
- Objective: 既存経路で英語訳を取得し、翻訳方向の混線を防ぐ。
- Scope:
  - workerとworker testsへ下書き要求を追加する。
  - SPEC-COMPOSE-004に従い、要求種別から翻訳先を決定する。
  - 固定英語promptと翻訳先を含むSHA-256 keyを追加する。
  - 実Chromeでの確認を実装開始の前提にしない。
- Acceptance Criteria:
  - 下書き要求は投稿済みmessage IDを要求しない。
  - 不正sender、未知種別、余分なfield、不正本文を拒否する。
  - 同じ本文でも日本語訳と英語訳はjobとcacheを共有しない。
  - 同じ翻訳先では既存の重複排除と成功cacheを維持する。
  - 既存の日本語prompt、生成設定、最終検証を維持する。
- Verification:
  - `npm --prefix extension test`で境界とcacheの回帰を検証する。
  - 固定の日本語短文を既存モデルへ送り、英訳を確認する。
  - 改行、Markdown、URL、コード、絵文字の保持を確認する。
  - 日本語の既存ケースも確認し、本文と訳文をログへ保存しない。

### Task 3: 投稿入力欄のボタンと完成訳の適用を追加する

- Status: 完了。実Chromeでの機能受け入れはユーザ確認で合格。
- Result:
  - 「英語に翻訳」と「元に戻す」を投稿入力欄の近くへ追加した。
  - 完成訳だけを入力欄へ反映し、古い応答を破棄する。
  - 復元対象は直近の翻訳前の下書き1件だけ保持する。
  - Node test 58件、Python self-check、変更JSの構文検証は成功した。
  - 2026-10-05のユーザ実機報告により、新機能の受け入れは合格した。
  - 個別の異常系・画面別・添付保持の実機試験内訳は未報告である。
- Objective: 英語訳へ置き換え、利用者が投稿前に確認できるようにする。
- Scope:
  - content script、styles、content testsを変更する。
  - 入力欄処理を受信メッセージ処理と分ける。
  - SPEC-COMPOSE-001〜003の状態と古い結果の破棄を実装する。
  - SPEC-COMPOSE-005の「元に戻す」と復元対象の管理を実装する。
  - READMEとcurrent文書の該当契約を同期する。
  - 実Chromeでの結合確認はTask 1、2完了を前提とする。
- Acceptance Criteria:
  - AC-019〜025が成立する。
  - 生成中は入力欄へ部分訳を書き込まない。
  - 編集後に同じ本文へ戻しても古い結果を適用しない。
  - 英語訳の編集後も「元に戻す」で翻訳直前の下書きへ戻せる。
  - 復元後は編集を続けられ、投稿や翻訳要求は発生しない。
  - 投稿、入力欄の空化、移動、交換、OFF後は復元対象を残さない。
  - OFF・交換・切断でPortとtimerを解放する。
  - 通常のクリック・キーボード操作でボタンを利用できる。
  - 既存の受信メッセージの日本語訳と順次表示が動く。
- Verification:
  - `npm --prefix extension test`で入力操作と遅延応答を検証する。
  - 変更JSに`node --check`を実行する。
  - `./.venv/bin/python scripts/verify.py --self-check`を実行する。
  - `git diff --check`を実行する。
  - 実Chromeで置換、編集継続、「元に戻す」、未投稿を確認する。
  - 実Chromeで翻訳中の編集・移動・OFF、失敗、添付保持を確認する。
  - 自動検証と実Chromeの確認結果を区別して記録する。

## Open Questions

- なし。
- 入力欄への下書き反映と復元方法は、Task 1の実装時の確認項目とする。

## References

- [PRD 第12節](../../current/PRD.md#12-投稿前の日本語から英語への翻訳案2026-10-05)
- [追加要求 REQ-F-018〜025](../../current/REQUIREMENTS.md#8-投稿前の英語翻訳の追加要求案2026-10-05)
- [外部仕様 SPEC-COMPOSE-001〜005](../../current/SPECIFICATIONS.md#13-投稿前の英語翻訳の仕様案2026-10-05)
- [設計 第13節](../../current/DESIGN.md#13-投稿前の英語翻訳の設計案2026-10-05)
- [ADR-003](../../adr/003-service-worker-owns-queue.md)
- [ADR-005](../../adr/005-extension-document-translation-bridge.md)
- [ADR-006](../../adr/006-manual-per-message-translation.md)
- [ADR-007](../../adr/007-streaming-translation.md)
