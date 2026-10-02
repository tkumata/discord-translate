# 訳文の順次表示と入力KV cacheの確認

## Status

- Phase: completed
- Approval: approved（2026-10-02「OK 進めてください。」）
- Date: 2026-10-02
- 入力KV cache: 既存設定の有効化・異なる原文間の再利用を実機確認済み。追加変更不要。

## Goal

現在のQwen3-8B-4bitによる翻訳が完成するまで待つ負担を減らし、生成された日本語訳から原文直下で読めるようにする。入力KV cacheは既存の再利用を維持する。

## Scope

- 固定streaming payload、bridgeのSSE読取り、workerの検証・累積・購読、contentの順次表示。
- 対象ソース: `extension/service-worker.js`、`extension/bridge.js`、`extension/content-script.js`。状態表示に必要な場合だけ`extension/styles.css`。
- 対象検証: 各3ファイルの既存Node test、`scripts/verify.py`のstreaming/KV cache検証。検証CLIの非streaming API確認は明示した独立モードとして維持できるが、Extension旧経路のfallbackには使わない。
- 関連文書: current 4文書、ADR-007と索引、README。本計画は実装後もactiveに残してTaskごとの結果・検証を記録する。

## Non-goals

- モデル変更、sampling/prompt短縮、並行数増加、timeout変更、長文分割、推測デコード。
- 新依存、独自HTTP server、cache層追加、本文/訳文の永続化、通常Discord要求の性能log追加。
- 自動翻訳、DOM scan最適化、jobの個別cancel/移管、無限retry、launchd。

## Required Behavior

- 仕様書SPEC-STREAM-001〜003とSPEC-KV-001、ADR-007に従う。
- 状態は`翻訳 -> 翻訳中… -> 日本語訳（翻訳中…） -> 日本語訳`。最初のchunk前/途中で失敗したら部分訳を除去し、固定errorと再試行へ戻す。
- cache hitは完成訳を一括表示する。重複jobは1 POSTと途中更新を共有し、途中参加者も生成済み部分を受け取る。
- 正常なfinish reason、usage、`[DONE]`まで確認してから成功とcache保存。reasoning、空応答、truncation、途中切断を成功扱いにしない。
- sender/Port/jobの対応、UTF-8/SSEの分割、絶対timeout、stale結果破棄、本文非logを維持する。

## Tasks

### Task 1: 入力 KV cache の現状確認

- Status: verified

- Objective: cacheが無効かどうかを実測し、不要な有効化変更を避ける。
- Scope: 既存serverとモデル、現行system prompt/payload、固定非機密入力のみ。source/config変更なし。
- Acceptance Criteria: 稼働モデルを確認し、異なる原文の後続要求で`cached_tokens > 0`を観測する。本文・訳文は出力・保存しない。
- Verification: `/health`、`/v1/models`、異なる固定英文3件のHTTP/usage/elapsed/finish/reasoning metadata。
- Result: 2026-10-02確認済み。HTTP 200、Qwen3-8B-4bit、cached tokensは0/66/66。全件stop、reasoningなし。詳細はSPEC-KV-001。入力cache有効化の実装は不要。

### Task 2: bridge の SSE transport

- Status: verified
- Result: SSE分割・CR/LF・UTF-8・usage/DONE、content-type、EOF、上限、abort/disconnect、privacyを実ReadableStreamで確認。Node testとJS構文確認合格。

- Objective: 既存HTTP境界でstreamを読み、chunkと終端をworkerへ渡す。
- Scope: `extension/bridge.js`、`extension/tests/bridge.test.js`。必要な固定payloadはSPEC-STREAM-001、bridge通知shapeはSPEC-STREAM-002。
- Acceptance Criteria: 固定URL/POST/streaming payloadだけを受理する。UTF-8・eventの分割/結合、CR/LF、コメント、usage、`[DONE]`を扱い、終端まで複数通知する。非200/parse failure/EOF/timeout/disconnectと、workerから同じPortへ届いた既知jobのabortでreader/timerを解放する。不正abortは他jobに影響しない。
- Verification: Nodeの実`ReadableStream`を用いた分割応答test、既存bridge境界test、`node --check extension/bridge.js`。worker結合はTask 3以降。

### Task 3: worker の stream 検証と共有購読

- Status: verified
- Result: progress/resultの分離、不正stream拒否、重複/途中参加/切断購読/成功cache、既存queue/timeoutを確認。bridge→registry→queueの実ReadableStream結合testと実モデル結合が成功。

- Objective: 途中通知と最終成功を分け、重複要求・cache・queueを維持する。
- Scope: `extension/service-worker.js`、`extension/tests/service-worker.test.js`。SPEC-STREAM-001/002、既存sender/input/queue/cache契約。
- Acceptance Criteria: 要求用Portとbridgeを区別して検証する。途中更新でjobを完了しない。分割think marker、reasoning、tool call、不正usage/finish、終端欠落を拒否する。同じjobの途中参加者へ累積訳を送り、1 POSTを共有する。成功時だけLRUへ保存し、切断購読者・終端済みjobを解放する。queue/timeoutの値は不変。
- Verification: 既存Node testを更新し、複数progress→1 result、途中参加、別tab通知、cache hit、失敗時cache miss、unknown job、絶対timeout、切断の観測可能な動作を確認する。Task 2とのPort結合testも行う。

### Task 4: content の順次表示

- Status: verified（自動検証。実ChromeはTask 5でユーザー確認済み）
- Result: 同じbodyの途中更新・確定、失敗時部分訳除去と再試行、OFF/編集/DOM交換/削除/切断、malformed通知、絶対240秒の監督を確認。styles.cssの変更は不要。

- Objective: 生成された訳文を同じ DOM ブロックへ更新し、生成中と確定を区別する。
- Scope: `extension/content-script.js`、`extension/tests/content-script.test.js`、必要な状態表示だけ`extension/styles.css`。SPEC-STREAM-003。
- Acceptance Criteria: 1クリック1要求Port。最初のprogressで部分訳を表示し、同じbodyへ更新する。完了前に確定ラベルにしない。失敗で部分訳を除去し再試行可能となる。OFF/編集/DOM交換後のすべての通知を破棄し購読を解放する。原文・改行・plain text・キーボード操作を維持する。
- Verification: 既存UI testにprogress前/途中/完了/失敗と、各状態でのOFF/本文変更/DOM交換/Port切断を加える。Task 2/3を前提とし、実Chrome表示はTask 5で別確認。

### Task 5: 実モデル・Chrome検証と仕様同期

- Status: verified
- Result: Extension test 50/50、Python self-check・構文確認合格。`--streaming --count 2`の固定8ケース成功。warm要求の初回content 0.402〜0.420秒、完了0.719〜1.915秒、後続7件でcached tokens 66〜68。実モデル→bridge→registry→queueの結合でも初回493ms、完了2141ms、30 progress、重複/cache込みPOST 1回、pending 0。本文・訳文は表示/保存していない。関連仕様とREADMEを同期済み。JS構文、文書8件のlocal link/anchor、`git diff --check`合格。検証用serverは停止済み。
- User Verification: 2026-10-02、ユーザーより「Task 5 の実機確認を行いました。問題ないです。完了としましょう。」との報告を受領。Task 5の実Chrome受け入れ確認を合格とし、本計画を完了する。エージェントによるChrome接続は利用できなかったため、実機確認の根拠はユーザー報告であり、新しい測定値やログは記録しない。
- Remaining: なし。本計画は`active/`に残す。

- Objective: 完了前に読めることと移行後のKV再利用を確認し、確認済み範囲だけを文書へ反映する。
- Scope: `scripts/verify.py`、その既存self-check、README、関連current文書、ADR-007/索引、本計画。新test frameworkや外部入力は追加しない。
- Acceptance Criteria: 固定非機密の複数chunk応答で最初の非空contentが最終完了より前に届く。異なる英文のstreaming usageでもcached tokens > 0。実Chromeで途中表示/完成、原文保持、重複、OFF/編集/途中失敗/再試行を確認する。仕様書の旧非streaming/one-time表現を承認済み新仕様へ同期する。
- Verification: Task 2〜4後に`cd extension && npm test`、変更JSの`node --check`、`python3 scripts/verify.py --self-check`、固定非機密streaming検証、実Chromeの長文と異常系、`git diff --check`。本文を記録せず初回content到達時刻と完了時刻、token metadataだけを確認する。未実施・失敗はそのまま記録する。

## Open Questions

設計上の未決事項はなし。部分訳除去、累積text通知、要求ごとのPortは承認・実装済み。入力KV cacheはstreamingでも再利用確認済み。Task 5の実Chrome検証はユーザー報告により合格。残作業なし。

## References

- [PRD](../../current/PRD.md#11-訳文の順次表示2026-10-02)
- [REQ-F-016/017・AC-017/018](../../current/REQUIREMENTS.md#7-訳文の順次表示の追加要求2026-10-02)
- [SPEC-STREAM-001〜003・SPEC-KV-001](../../current/SPECIFICATIONS.md#12-訳文の順次表示と入力kv-cache2026-10-02)
- [設計](../../current/DESIGN.md#12-訳文の順次表示2026-10-02)
- [ADR-007](../../adr/007-streaming-translation.md)
