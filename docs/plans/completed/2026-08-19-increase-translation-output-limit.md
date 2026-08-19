# 翻訳出力上限を1024へ引き上げる実行計画

## Status

- State: Implemented; automatic validation complete, real Chrome validation pending
- Date: 2026-08-19
- Approval: 2026-08-19 利用者承認済み。

## Objective

長文翻訳で多発している `finish_reason=length` を、既存の翻訳経路と失敗時動作を変えず、生成上限を `max_tokens=512` から `1024` へ引き上げて解消する。

## Current state

- 実際の翻訳応答で `finish_reason="length"`、`completion_tokens=512` が観測され、現在の生成上限まで到達して訳文が途中で終了している。
- `extension/service-worker.js` の `buildPayload` は `max_tokens: 1024` を送信する。
- `extension/bridge.js` の `validateBridgeRequest` は `payload.max_tokens === 1024` だけを正規のbridge要求として受理する。
- `extension/tests/service-worker.test.js` は送信payloadの `1024` を固定し、bridge testは `1024` の受理と `512` の拒否を検証する。
- `scripts/verify.py` の `--max-tokens` 既定値、READMEのpayload例とtruncation案内、`docs/current/SPECIFICATIONS.md` の現行API契約は `1024` に一致している。
- `finish_reason=length` は現在どおり失敗として扱われ、原文を保持して固定error codeと再試行buttonを表示する。

## Scope

- `extension/service-worker.js` の固定payloadを `max_tokens: 1024` へ変更する。
- `extension/bridge.js` の固定payload検証を `payload.max_tokens === 1024` へ同期する。
- `extension/tests/service-worker.test.js` のpayload契約を `1024` に更新する。
- `extension/tests/bridge.test.js` に、`1024` を受理し旧値 `512` を拒否する最小の回帰条件を固定する。
- `scripts/verify.py` の `--max-tokens` 既定値を `1024` へ変更する。明示指定された値を尊重する既存動作は維持する。
- READMEのcurl payload例と `finish_reason=length` の案内を、新しい既定値 `1024` と一致させる。
- `docs/current/SPECIFICATIONS.md` の現行API payload契約と説明を `1024` に同期する。
- 実装完了後、本計画の `Status`、`Progress`、`Outcome` を更新し、`docs/plans/completed/` へ移動する。

## Out of scope

- 長文の分割翻訳、途中結果の結合、継続生成
- `finish_reason=length` 時の自動再試行、別payloadでの再送、fallback
- 新しい依存関係、設定項目、共通定数、抽象化
- system prompt、sampling値、thinking設定、response schema、成功応答条件、固定error codeの変更
- timeout、queue、cache、concurrency、bridge protocol、server、モデル、起動設定の変更
- popup、content script、manifest、権限、UIの変更
- `1024` でも収まらない入力への対応。実測で再発した場合だけ、入力制約または別方式を別計画で検討する。

## Approach

1. 既存の固定payloadを構成するservice workerと、それを検証するbridgeの数値を `1024` に揃える。新しい設定層や共有定数は追加しない。
2. 既存のNode標準testでservice workerの送信値を固定し、bridgeが新値だけを受理して旧値を拒否する境界を1ケースで検証する。
3. 検証CLIの既定値と、利用者が参照するREADME、現在仕様の正本を同じ値へ同期する。
4. `finish_reason=length` の拒否は維持し、切断された訳文を成功扱いにしない。

## Affected files

- `extension/service-worker.js`
- `extension/bridge.js`
- `extension/tests/service-worker.test.js`
- `extension/tests/bridge.test.js`
- `scripts/verify.py`
- `README.md`
- `docs/current/SPECIFICATIONS.md`
- `docs/plans/active/2026-08-19-increase-translation-output-limit.md`

`REQUIREMENTS.md`、`DESIGN.md`、`PRD.md`、ADRは、要求、責務分割、製品目的、長期設計判断が変わらないため更新しない。

## Phase

### Phase 1: 出力上限契約の同期と検証

- 目的: Extension既定経路と検証CLIの生成上限を `1024` に揃え、観測済みの512-token切断を回避する。
- 前提: 本計画のScopeについて利用者の承認を得ること。
- 対象: 上記Affected filesの `max_tokens` 契約、回帰test、現在文書。
- 対象外: 分割、再試行、timeout、queue、server、モデル、response受理条件。
- 完了条件:
  - service workerが `max_tokens: 1024` のpayloadを生成する。
  - bridgeがそのpayloadを受理し、`max_tokens: 512` のpayloadを拒否する。
  - `scripts/verify.py` は未指定時に `1024`、明示指定時に指定値を使う。
  - READMEと現在仕様が実装値 `1024` に一致する。
  - `finish_reason=length`、reasoning、空contentなどの既存失敗条件と、timeout・queue・bridge経路に回帰がない。
- 検証方法:
  - `cd extension && npm test`
  - `node --check extension/service-worker.js`
  - `node --check extension/bridge.js`
  - `python3 -m py_compile scripts/verify.py`
  - `python3 -c 'from scripts.verify import parse_args; assert parse_args([]).max_tokens == 1024; assert parse_args(["--max-tokens", "512"]).max_tokens == 512'`
  - `python3 scripts/verify.py --self-check`
  - `git diff --check`
  - Extensionをreloadし、提示された長文を既定bridge経路で再翻訳する。server側応答で `finish_reason="stop"` となり、Discord上の訳文が末尾まで表示されることを確認する。Node testやCLI self-checkだけでは実モデルの切断解消を証明しない。
- 文書更新: `README.md`、`docs/current/SPECIFICATIONS.md`、本計画の状態・進捗・結果だけを同期する。
- 未解決事項: 同じ長文が `1024` 以内で必ず完了するかは、実モデルを使った既定bridge経路の再検証まで未確定。
- 次フェーズへの引き継ぎ: 実Chrome検証は未実施。実モデルでの完走確認が必要な場合は別途実施する。

## Success criteria

- コード、bridge検証、Node test、検証CLI既定値、README、現在仕様の `max_tokens` がすべて `1024` で一致する。
- 旧値 `512` のbridge payloadを拒否する契約が回帰testで固定される。
- 提示された長文の実Chrome翻訳が `finish_reason="stop"` で完了し、訳文が末尾まで表示される。
- `finish_reason=length` を成功扱いにせず、既存の安全な失敗動作を維持する。
- 新規依存、分割、自動再試行、設定層、timeout・queue・server変更を追加しない。

## Validation

| 領域 | 最小検証 | 完了判定 |
| --- | --- | --- |
| Payload契約 | service worker testとbridgeの新値受理・旧値拒否test | `1024` だけが既定bridge経路を通る |
| CLI | 構文検査、既定値・明示値assert、`--self-check` | 未指定は `1024`、明示指定は維持 |
| 回帰 | `cd extension && npm test` | 既存response拒否、timeout、queue、cacheを含め全件成功 |
| 文書 | 対象差分と `rg -n "max_tokens|512|1024"` | READMEと現在仕様が実装契約に一致 |
| 実動作 | 実Chrome既定bridge経路で提示された長文を再翻訳 | `finish_reason="stop"` かつ末尾まで表示 |
| Repository | `git diff --check`、対象ファイル差分、`git status --short` | whitespace errorなし、承認範囲外の変更なし |

## Risks

- 出力上限の増加により、長い応答では生成時間とメモリ使用量が増える可能性がある。既存の120秒timeoutは変更せず、実Chrome検証で完走時間を観測する。
- `1024` でも入力内容によっては `finish_reason=length` が再発し得る。その場合も切断結果を受理せず、実測を根拠に別計画で扱う。
- bridgeの固定値を同期し忘れると正しいservice worker要求が `invalid_response` になるため、新値受理と旧値拒否を同じ回帰testで固定する。

## Progress

- 完了: `finish_reason="length"` と `completion_tokens=512` の観測結果を根因として確認した。
- 完了: service worker、bridge、Node test、検証CLI、README、現在仕様にある `512` 契約を特定した。
- 完了: `512` から `1024` への最小同期範囲、対象外、成功条件、検証方法を確定した。
- 完了: Phase 1の実装。固定payload、bridge検証、回帰test、検証CLI既定値、README、現在仕様を `1024` へ同期した。
- 完了: `cd extension && npm test`（38件）、Node構文検査、Python構文検査、CLI既定値・明示値assert、`--self-check`、`git diff --check`。
- 未実施: Extensionをreloadした実Chrome既定bridge経路での提示長文の再翻訳。`finish_reason="stop"` と末尾表示は未確認。
- 変更済みファイル: Affected filesの実装・test・文書、および本計画文書。
- 未解決事項: `1024` で提示された長文が実モデル上 `finish_reason="stop"` になるかは未検証。

## Decisions

- 観測済みの上限到達へ直接対応するため、固定値を `1024` に引き上げるだけとする。
- `finish_reason=length` の拒否は維持し、不完全な訳文を成功扱いにしない。
- 分割、自動再試行、設定化、新依存は実測上不要なため追加しない。
- 長期設計判断は変わらないためADRを追加しない。

## Outcome

固定 `max_tokens` を `512` から `1024` へ変更し、service worker・bridge・test・検証CLI・README・現行仕様を同期した。自動検証はすべて成功した。実Chrome/実モデル検証はこの実行では未実施のため、提示された長文の切断解消は未確認であり、Success criteriaの実動作項目を完了扱いにしない。
