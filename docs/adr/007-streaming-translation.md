# ADR-007 訳文の順次表示を既存bridgeと要求用Portで行う

## Status

Accepted, implemented — 2026-10-02承認。ADR-003/005/006の所有境界と手動翻訳契機を維持し、完成JSON/one-time応答だけの部分を置き換えた。Node/実モデル検証は成功、実Chromeも2026-10-02のユーザーによるTask 5実機確認で合格し、本変更は完了。

## Context

変更前の翻訳は意図どおり動くが、`stream=false`の応答が完成するまで日本語訳を読めない。利用者は現在のQwen3-8B-4bitを維持した順次表示を希望している。公式MLX-LM 0.31.3はSSEとusage eventに対応する。入力KV cacheは異なる原文間の66 token再利用を実機確認済みで、追加のcache層は不要である。

## Decision

固定翻訳payloadを`stream=true`、`stream_options.include_usage=true`へ移行する。HTTPとSSE解析はhidden Extension bridge、内容の検証・累積・queue/cacheはservice worker、部分訳の表示はcontent scriptに置く。

contentとの翻訳通信は1要求につき1つの名前付き`runtime.Port`とし、途中累積text、最終text、固定errorを返す。bridgeとの通信は既存Portにchunk/end通知を追加する。重複要求は既存jobと1回のPOSTを共有し、途中参加者へ累積訳文を渡す。

部分訳は翻訳中と明示し、正常終了・usage・`[DONE]`を最終検証した場合だけ確定・cache保存する。失敗時は部分訳を除去し、原文を残して再試行UIへ戻す。OFF/編集/DOM交換では購読を外し、共有jobのcancelは追加しない。

## Alternatives

### 完成JSON応答を維持する

- 利点: 変更不要。
- 欠点: 生成済みの訳文を完了前に読むという要求を満たさない。

### one-time要求と別経路のprogress通知を併用する

- 利点: 既存要求入口を維持できる。
- 欠点: 要求とprogressの対応に別ID/経路を必要とする。1要求用Portで両方を扱う方が単純である。

### content scriptからSSE APIを直接呼ぶ

- 利点: 中継処理を減らせる。
- 欠点: sender/input、queue/cache、LNA/CORS、HTTP責務の既存境界を迂回する。

## Rationale

既存runtimeと標準Chrome/Web APIで要求を満たせる。PortをDOM recordへ対応させることで、部分通知の識別のための新しいIDや通知サービスを追加せず、既存の所有境界を保てる。

## Consequences

### Positive

- 生成完了前から日本語訳を読める。
- モデル、loopback/offline、権限、queue並行数1、成功訳文cacheを維持できる。
- 入力KV cacheは現在の実装をそのまま再利用する。

### Negative

- SSE分割、終端、usage、途中切断、重複購読の動作検証が必要になる。
- 部分訳は生成中のため未確定であり、最終的に失敗した場合は画面から除去する。
- Port開設だけではworkerの存続を保証しない。終了時は固定errorと手動再試行で復旧する。
- 生成自体の高速化や短縮率は保証しない。

## References

- [追加要求 REQ-F-016/017・AC-017/018](../current/REQUIREMENTS.md#7-訳文の順次表示の追加要求2026-10-02)
- [SPEC-STREAM-001〜003・SPEC-KV-001](../current/SPECIFICATIONS.md#12-訳文の順次表示と入力kv-cache2026-10-02)
- [ADR-003](003-service-worker-owns-queue.md)、[ADR-005](005-extension-document-translation-bridge.md)、[ADR-006](006-manual-per-message-translation.md)
- [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Chrome worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [MLX-LM 0.31.3 server](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/server.py)
