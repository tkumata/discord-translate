# invalid_response 診断メタデータ追加 実行計画

## Status

- State: Completed; implementation, automated validation, and document sync complete
- Date: 2026-08-19
- Approval: `invalid_response` 多発原因を特定するための最小診断ログ追加を承認済み。本文・訳文・URL・`error.message` の記録は禁止する。

## Objective

Chrome Extension の翻訳失敗で多発する `invalid_response` について、API 応答内容を漏えいさせず、`finish_reason`、content の有無、reasoning の有無、`usage.total_tokens` の有無だけから失敗条件を特定できるようにする。

## Current state

- `extension/bridge.js` は localhost の HTTP 200 応答を JSON 解析できない場合に `invalid_response` を返すが、原因を示す診断値は残さない。
- `extension/service-worker.js` の `validateResponse` は、応答object、`choices[0]`、`finish_reason === "stop"`、message content、reasoning/thinking、`usage.total_tokens` を順に検証し、どの条件でも同じ `invalid_response` を返す。
- UI には固定error codeだけが表示されるため、現在の `invalid_response` だけでは `finish_reason=length`、content欠落、reasoning混入、usage欠落を区別できない。
- `scripts/verify.py` は失敗理由を区別するが Extension の既定bridge経路ではなく、`finish_reason="tool_calls"` を許可する点も Extension と異なる。今回この契約差は変更しない。
- 現行privacy契約は、本文、訳文、request/response body、URL、`error.message` をconsole・通常log・storageへ保存しないことを要求している。

## Scope

- `invalid_response` 発生時だけ、Chrome DevTools console に次の4項目から成る固定shapeの診断メタデータを1件出す。
  - `finish_reason`: JSON応答から安全に取得できる場合は値、取得不能または欠落時は `null`
  - `content_present`: `choices[0].message.content` が文字列として存在するかのboolean
  - `reasoning_present`: 応答、choice、message のいずれかに `reasoning` または `reasoning_content` が存在するか、またはcontentに `<think>` / `</think>` が含まれるかのboolean
  - `usage_total_tokens_present`: `usage.total_tokens` が非負整数として存在するかのboolean
- bridgeでJSON解析できない場合も、取得不能を表す `finish_reason: null` と3つの `false` だけを同じ固定shapeで記録する。
- service worker の最終response検証で拒否した場合は、同じ固定shapeを記録してから既存の `invalid_response` を返す。
- 既存の `console` を使い、新規logger、telemetry、永続化、依存関係は追加しない。
- 診断shapeと「禁止データをconsoleへ渡さない」ことを Node標準testで固定する。
- 実装完了後、内容が変わる現在文書と本計画を同期する。

## Out of scope

- 本文、訳文、prompt、request/response body、message ID、job ID、tab ID、URL、HTTP header、`error.message`、例外objectの記録
- `chrome.storage`、ファイル、DB、server log、外部telemetryへの保存・送信
- API payload、system prompt、sampling値、`max_tokens`、thinking設定、response受理条件、固定error codeの変更
- `tool_calls` の許可、automatic retry、queue/cache、timeout、bridge protocol、UIの変更
- server、`scripts/verify.py`、popup、content script、manifest、権限、依存関係の変更
- 診断結果に基づく修正。原因確定後、必要な変更だけを別途計画する。

## Approach

1. `extension/service-worker.js` に、任意の値から4項目だけのplain objectを組み立てる小さな診断関数を置く。応答objectそのものや例外をloggerへ渡さない。
2. `validateResponse` の失敗を既存の `invalid_response` へ正規化する直前だけ診断関数を呼び、成功時にはlogしない。検証順序と受理条件は維持する。
3. `extension/bridge.js` のJSON解析失敗では、解析前の文字列や例外を使わず、全項目が取得不能な固定メタデータだけを出す。それ以外のbridge errorは今回のAPI応答診断対象にしない。
4. 既存の `node:test` と注入可能な最小loggerを再利用し、代表的な失敗ごとの4項目と禁止データ非出力を検証する。新しい抽象化やtest frameworkは追加しない。

## Privacy boundary

- 診断値はChrome ExtensionのDevTools consoleでのみ一時的に観測し、永続storageや外部送信を行わない。
- loggerへ渡せる値は固定ラベルと4項目のplain objectだけとする。元payload、content文字列、翻訳入力、例外、URLを渡さない。
- `content_present` と `usage_total_tokens_present` は値そのものではなく妥当な型・範囲で存在するかだけをboolean化する。
- `reasoning_present` はreasoning本文を記録せず、fieldまたはthinking markerの有無だけをboolean化する。
- `finish_reason` は失敗分類に必要なresponse metadataだけを記録する。文字列以外や取得不能は `null` とし、任意objectを文字列化しない。
- UIへ返す値は従来どおり `invalid_response` だけとし、診断値をcontent scriptへ渡さない。

## Affected files

- `extension/service-worker.js`
- `extension/bridge.js`
- `extension/tests/service-worker.test.js`
- `extension/tests/bridge.test.js`
- `docs/current/SPECIFICATIONS.md`
- `docs/current/DESIGN.md`
- `docs/plans/completed/2026-08-19-invalid-response-diagnostics.md`

README、REQUIREMENTS、PRD、ADRは外部操作、要求、製品目的、長期設計判断を変えないため更新しない。

## Phase

### Phase 1: privacy-safe 診断メタデータ実装と検証

- 目的: `invalid_response` の主要失敗条件を、内容データを記録せず区別できるようにする。
- 前提: 本計画のScopeとprivacy境界が承認済みであること。
- 対象: 上記Affected files。bridgeのJSON解析失敗とservice workerの最終response検証失敗。
- 対象外: response受理条件、翻訳品質、性能、API/server/UI、原因確定後の修正。
- 完了条件:
  - `finish_reason=length` で `finish_reason: "length"` を観測できる。
  - content欠落または非文字列で `content_present: false` を観測できる。
  - reasoning fieldまたはthinking markerで `reasoning_present: true` を観測できる。
  - `usage.total_tokens` 欠落・非整数・負数で `usage_total_tokens_present: false` を観測できる。
  - bridgeのJSON解析失敗では4項目以外を含まない取得不能shapeを観測できる。
  - 有効な応答では診断logが出ず、翻訳結果と既存error code契約が変わらない。
  - 本文、訳文、payload、response、URL、`error.message`、例外objectがconsole引数とstorageへ渡らない。
- 検証方法:
  - `cd extension && npm test`
  - `node --check extension/service-worker.js`
  - `node --check extension/bridge.js`
  - `git diff --check`
  - Chrome Extensionをreloadし、失敗を再現してservice worker/bridgeのDevTools consoleで固定shapeを確認する。本文・訳文・URL・例外messageが表示されないことを同時に確認する。
- 文書更新: `docs/current/SPECIFICATIONS.md` のログ・失敗時動作、`docs/current/DESIGN.md` のresponse検証責務、本計画のStatus・Progress・Outcome。
- 未解決事項: 実Chromeでどの失敗条件が多数を占めるかは診断実装後の再現まで未確定。
- 次フェーズへの引き継ぎ: 観測件数が最も多い条件だけを根因候補として扱い、payload値や受理条件を変更する場合は別計画で明示する。

## Success criteria

- 4項目だけで、少なくとも `finish_reason`、content、reasoning、usageのどの条件でAPI応答が拒否されたかを分類できる。
- `invalid_response` の返却、翻訳成功、queue/cache/bridge経路に回帰がない。
- 禁止データをconsole、storage、外部通信へ追加しないことが自動testと実Chrome確認で担保される。
- 新規依存、永続診断基盤、汎用loggerを追加しない。

## Validation

- 自動: 既存Extension test全件、対象JS構文検査、固定shape・成功時無log・privacy否定test、`git diff --check`。
- 手動: Extension reload後、代表的な `invalid_response` を再現し、4項目だけが表示されることを確認する。
- 判定境界: Node test合格は診断ロジックの証明であり、実際の多発原因の確定ではない。原因確定には実Chrome既定bridge経路での再現logが必要である。

## Risks

- JSON解析不能と、JSON object内で4項目すべてが欠落した応答は同じ取得不能shapeになる。この計画では内容データを増やさず安全側に倒し、両者の厳密な区別が必要になった場合だけ別の固定分類codeを検討する。
- Chrome DevToolsを開いていない期間のlogは調査に使えない。永続化はprivacyとYAGNIのため追加しない。
- `finish_reason` に想定外の文字列が入る場合もmetadataとしてconsoleへ出る。モデル出力本文ではないが、必要なら既知値への正規化を実装時reviewで選ぶ。

## Progress

- 完了: 現行 `invalid_response` 発生箇所、response検証、bridge JSON解析、既存test、privacy仕様を確認した。
- 完了: 実装対象、対象外、成功条件、検証、privacy境界を確定した。
- 完了: Phase 1の実装、自動検証、現在文書の同期。
- 変更済みファイル: `extension/service-worker.js`, `extension/bridge.js`, `extension/tests/service-worker.test.js`, `extension/tests/bridge.test.js`, `docs/current/SPECIFICATIONS.md`, `docs/current/DESIGN.md`。
- 未解決事項: 実Chromeで支配的な失敗条件を観測すること。

## Decisions

- 診断は既存consoleへの非永続metadata出力だけとし、logger基盤やstorageを追加しない。
- 失敗原因を直す前に、既存受理条件を変えず4項目だけを観測する。
- 長期設計判断は変更しないためADRを追加しない。

## Outcome

完了。service workerの最終応答検証とbridgeのHTTP 200 JSON parse失敗で、本文・訳文・payload・response・URL・ID・`error.message`・例外objectを渡さず、固定ラベルと4項目だけをDevTools consoleへ出す診断を追加した。既存の受理条件、固定error code、payload、timeout、queue/cache、bridge protocolは変更していない。`cd extension && npm test` は38件全件合格、`node --check extension/service-worker.js`、`node --check extension/bridge.js`、`git diff --check` は合格した。実Chromeでの失敗条件別件数確認はホスト操作が必要なため未実施。
