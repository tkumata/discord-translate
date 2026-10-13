# ローカル / ChatGPT 翻訳先の選択

- Status: completed
- Date: 2026-10-12
- Completed: 2026-10-12。ユーザの実機動作確認と完了指示による。
- Approval: ユーザは文書作成後の実装を承認した。
- Goal: 既存の翻訳操作でローカルと ChatGPT を選択する。
- Scope: 設定、認証用補助、通信、cache、変更時の lifecycle、文書、テスト。
- Non-goals: 自動翻訳、投稿、複数アカウント UI、モデル設定 UI、API key、常駐起動。

## Tasks

### Task 1: 文書と境界の確定

- Status: completed
- Result: ADR-009 と現在文書へ承認範囲を記載した。
- Scope: PRD、REQUIREMENTS、SPECIFICATIONS、DESIGN、ADR、README。
- Required Specifications: SPEC-PROVIDER-001〜004。
- Acceptance Criteria: 外部送信の例外と認証保管を明記する。
- Verification: 既存のローカル専用条件との整合確認。

### Task 2: 認証と ChatGPT 翻訳用の補助プログラム

- Status: completed
- Result: OAuth、固定翻訳用 HTTP、Responses 変換を実装した。認証・HTTP の自動テスト12件成功。
- Scope: `scripts/chatgpt-auth.mjs`、`scripts/chatgpt-server.mjs` とテスト。
- Required Specifications: SPEC-PROVIDER-002、003。
- Acceptance Criteria: callback、JWT、refresh、切断と保存の競合を検証する。
- Acceptance Criteria: 不正 origin / Host / payload を推論前に拒否する。
- Acceptance Criteria: 正常完了前の EOF と不完全応答を成功にしない。
- Verification: Node 標準 test。署名付き fixture と模擬 OpenAI 応答を使う。
- Verification: 実 loopback HTTP と一時 directory で結合確認する。

### Task 3: 拡張の選択、通信、cache と画面更新

- Status: completed
- Result: 翻訳先の選択と通信、cache 分離、切替の lifecycle、再接続と利用量の案内を実装した。
- Scope: popup、worker、queue、bridge、cache、起動、関連テスト。
- Required Specifications: SPEC-PROVIDER-001、004。
- Acceptance Criteria: 翻訳先を受付時点で固定し、異なる訳を共有しない。
- Acceptance Criteria: 切替で購読と UI を破棄し、下書き本文は保持する。
- Acceptance Criteria: ローカルの既存保存訳と設定の互換性を維持する。
- Verification: `npm --prefix extension test`。

### Task 4: 結合検証と利用手順

- Status: completed
- Result: README にセットアップ・送信先・認証保管・利用制限を記載した。
- Result: `npm --prefix extension test`: 91 passed / 0 failed / 0 skipped。
- Result: `python3 scripts/verify.py --self-check`: PASS。通信・本文出力なし。
- Result: JavaScript 29ファイルの `node --check`、manifest JSON、`git diff --check`: PASS。
- Environment: loopback HTTP test は sandbox の listen EPERM により通常実行不能。承認済み sandbox 外実行で成功した。
- Result: 認証成功はユーザ報告。実 API の header 欠落・最終 output 空配列で旧実装の失敗を再現し、回帰条件を追加した。
- Result: 修正済み補助と実 API で固定文の日訳・英訳が正常完了。既存プロセスと認証保存は変更せず、本文・tokens を出力しなかった。
- Acceptance: 2026-10-12、ユーザが実機での動作確認成功を報告し、完了を指示した。本変更の実 Chrome 受け入れを合格とする。
- Unverified: 個別の操作・異常系の実機試験内訳、利用枠上限の実挙動と長文品質は未確認。
- Scope: README、文書の実装状態、最終差分、構文と既存 self-check。
- Acceptance Criteria: 成功済み自動検証と未確認の実機条件を分ける。
- Verification: Node test、Python self-check、JS 構文、`git diff --check`。
- Verification: 実アカウントと実 Chrome は利用可能な場合だけ実施する。
- Limitation: 未確認のログイン、利用枠、翻訳品質を合格と記録しない。

## Open Questions

本変更の完了を妨げる未決事項はない。自動検証、実 API 検証とユーザの実機受け入れを区別して記録した。

## References

- [ADR-009](../../adr/009-chatgpt-plan-translation.md)
- [要求](../../current/REQUIREMENTS.md)
- [仕様](../../current/SPECIFICATIONS.md)
- [設計](../../current/DESIGN.md)
