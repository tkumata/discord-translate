# 受信メッセージの翻訳文を5日間保持する

## Status

- Phase: completed
- Approval: approved — 2026-10-05、ユーザが文書と実装を承認
- Created: 2026-10-05
- Implementation: Task 1〜3完了。planはactiveに保持する。
- Verification: Node test 70件、変更JSの構文チェック、git diff --check成功。実Chrome受け入れはユーザ確認で合格。実時間5日経過は未確認。

## Goal

表示された受信メッセージの完成訳を5日間保存する。
ページ遷移後に同じメッセージの翻訳ブロックを復元する。

## Scope

- 受信翻訳専用のローカル永続保存と期限判定。
- チャンネル、DM、スレッドの既存対象メッセージの復元。
- IDと原文hashによる照合と遅延応答の失効。
- 容量不足、読込み失敗、保存失敗の固定code通知。
- 受信キャッシュの動作テストと既存動作の回帰検証。
- 承認後の現在文書とREADMEの保存方針の同期。

## Non-goals

- 投稿入力欄の下書きと投稿用の英語訳の永続保存。
- 原文、途中訳、失敗結果の永続保存。
- 自動翻訳、自動投稿、履歴検索、キャッシュ管理画面。
- サーバ側の保存、新依存、新しい権限。
- 未完了jobの復旧と5日後の厳密な時刻での物理削除。
- 既存の30分・256件のメモリキャッシュの変更。

## Required Behavior

MUSTは必須、SHOULDは推奨、MAYは任意を表す。

### 確定事項

- MUST: 保存対象は表示された受信メッセージの完成訳とする。
- MUST: 保存期間は5日間とする。
- MUST: 投稿用の翻訳は永続保存対象から外す。
- MUST: 投稿用の既存30分のメモリキャッシュは維持する。

### 承認済みの具体化

- MUST: 初回保存成功から120時間を有効期間とする。
- MUST: `chrome.storage.local`へ個別キーで保存する。
- MUST: メッセージIDと原文hashが一致する訳文だけを復元する。
- MUST: ON中だけ保存訳を復元する。
- MUST: 保存訳がない場合は手動翻訳ボタンを表示する。
- MUST: 復元と検索では翻訳APIへPOSTしない。
- MUST: 復元とOFF/ONでは保存期限を延長しない。
- MUST: 有効な保存訳を件数制限や容量不足で早期削除しない。
- MUST: 保存失敗は完成訳を表示したまま固定codeで通知する。

標準容量上限は10MBである。
容量上限超過では新規保存の5日間保持を保証できない。
期限切れデータは次のworker起動または保存前に物理削除する。
保存期限の失効判定は物理削除の成功に依存しない。

## Tasks

### Task 1: 受信完成訳の永続保存境界

- Status: completed
- Result: 5日期限、復元検索、個別キー保存、エラー通知のNode検証成功。

- Objective: 受信完成訳を安全に保存・取得し、5日期限を判定する。
- Scope: `extension/service-worker.js`と受信保存処理の関数群。
- Scope: workerのテスト。必要なら保存処理だけを別ファイルに分離する。
- Required Specifications: SPEC-CACHE-001、002、004とDESIGN第14節。
- Acceptance Criteria: AC-027、029〜031のworker側条件を満たす。
- Acceptance Criteria: 検索要求からqueueとbridgeを呼ばない。
- Acceptance Criteria: 投稿用翻訳は保存処理を通らない。
- Acceptance Criteria: 有効期間内の同じキーの再保存で期限を延ばさない。
- Verification: 共有Storage APIを使うworker再生成のNodeテスト。
- Verification: 時計差替えで120時間の直前と境界を確認する。
- Verification: 複数タブ、容量不足、例外、途中失敗を確認する。
- Verification: `npm --prefix extension test`。

### Task 2: 表示メッセージの保存訳復元

- Status: completed
- Result: ページとworkerの再生成、編集、ID変更、OFF、UI削除のNode検証成功。

- Objective: ページ再表示と再描画で正しい翻訳ブロックを復元する。
- Scope: `extension/content-script.js`とcontent scriptのテスト。
- Required Specifications: SPEC-CACHE-003、004と既存の翻訳UI仕様。
- Acceptance Criteria: AC-026、028、030のUI側条件を満たす。
- Acceptance Criteria: 本文とIDとrecordで遅延結果を失効させる。
- Acceptance Criteria: 同文の別IDと返信プレビューに訳文を流用しない。
- Acceptance Criteria: 同じDOMのID変更と追加UIの削除も扱う。
- Verification: Task 1の検索・保存経路を前提とする。
- Verification: 再初期化とstorage通知を含むNodeの動作テスト。
- Verification: OFF、編集、DOM交換、ID変更、重複scanを確認する。
- Verification: 復元時に翻訳POSTが0件であることを確認する。
- Verification: `npm --prefix extension test`。

### Task 3: 結合確認と保存方針の同期

- Status: completed
- Result: 現在文書、ADR-008、READMEの同期完了。
- Result: ユーザは2026-10-05に実Chromeでページ遷移後の復元を確認した。
- Limitation: エージェントによる実Chrome操作は未実施。実機受け入れの根拠はユーザ報告。
- Limitation: 個別の画面、worker再生成、storage確認、異常系の実機試験内訳は未報告。
- Limitation: 実時間5日経過は未確認。期限は時計差替えで検証した。

- Objective: 実際の遷移で復元し、承認済みの保存方針を文書へ反映する。
- Scope: 現在文書、ADR-008、READMEとTask 1〜2の結合検証。
- Required Specifications: SPEC-CACHE-001〜004、AC-026〜031。
- Acceptance Criteria: 自動確認と実Chrome確認の結果を区別する。
- Acceptance Criteria: 新機能の未確認範囲を成功扱いしない。
- Acceptance Criteria: 受信完成訳の保存例外を既存禁止記述へ同期する。
- Verification: Task 1〜2の成功済み自動検証は理由なく繰り返さない。
- Verification: 変更JSの`node --check`と`git diff --check`。
- Verification: 実Chromeでチャンネル、DM、スレッドを往復する。
- Verification: 実Chromeでページ再読込とworker再生成後に復元する。
- Verification: 実Chromeで投稿用の英語訳が永続保存されない。
- Verification: 非機密の固定入力で保存領域とPOST件数を確認する。
- Verification: 実時間5日経過は未実施とし、時計差替えの結果と分ける。

## Open Questions

なし。投稿用キャッシュの意味は利用者の回答で確定した。
期限の起算点と容量超過時の動作は、ユーザが承認した。

## References

- [製品ゴール](../../current/PRD.md#13-受信メッセージの翻訳文を5日間保持する案2026-10-05)
- [追加要求](../../current/REQUIREMENTS.md#9-受信翻訳文の5日間保持案2026-10-05)
- [外部仕様](../../current/SPECIFICATIONS.md#14-受信翻訳文の永続キャッシュ案2026-10-05)
- [設計](../../current/DESIGN.md#14-受信翻訳専用の永続キャッシュ案2026-10-05)
- [ADR-008](../../adr/008-persist-received-translations.md)
