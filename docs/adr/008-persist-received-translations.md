# ADR-008 受信メッセージの完成訳だけを5日間保存する

## Status

Accepted, implemented — 2026-10-05にユーザが文書と実装を承認した。
Node自動検証成功。実Chrome受け入れは2026-10-05のユーザ確認で合格。
ADR-002、003の永続保存禁止に限定した例外を設ける。
既存ADRは変更しない。

## Context

ページ遷移で翻訳ブロックが失われる。
現在のcacheはworker内のメモリに最大256件・30分保持する。
現在のUIは再検出時に完成訳を自動復元しない。
利用者は表示された受信メッセージの翻訳文を5日間保持したい。
利用者は投稿用の翻訳を永続保存しない。
投稿用の既存メモリキャッシュは維持すると利用者が回答した。

## Decision

受信翻訳専用の永続保存処理をservice workerに置く。
保存先は既存の`storage`権限による`chrome.storage.local`とする。
MUST: 保存対象は有効な受信要求の検証済み完成訳に限定する。
MUST: 原文と下書きと投稿用の英語訳は永続保存しない。
MUST: メッセージIDと原文hashを含むキーで照合する。
MUST: 保存成功から120時間を有効期間とする。
MUST: 検索hitを表示し、missから自動翻訳を開始しない。
MUST: 保存容量不足でも有効な既存訳を早期削除しない。
MUST: 保存失敗は完成訳を残して固定codeで通知する。

既存queue、30分のメモリキャッシュ、bridgeの境界を維持する。
外部通信と本文を含む通常ログは禁止する。

## Alternatives

### Option A: 既存メモリキャッシュのTTLだけを延ばす

- 利点: 小さい変更で済む。
- 欠点: worker終了と再読込で保存訳が失われる。
- 欠点: メッセージごとの自動復元条件を持たない。

### Option B: IndexedDBを使う

- 利点: 大量データとトランザクションを扱える。
- 欠点: 初期要件に対してDB初期化と移行処理が増える。
- 判断: Storage APIの容量不足が実測された場合に再検討する。

## Rationale

既存のStorage APIとメッセージ識別で要求を満たせる。
翻訳結果の再利用と画面表示の復元は異なる責務である。
両キャッシュを分けると、投稿用翻訳の保存を防げる。
個別キーの保存で、別タブによる全体更新の消失を避けられる。

## Consequences

### Positive

- 遷移、再読込、worker再生成後に完成訳を復元できる。
- 保存訳の復元ではモデル推論を行わない。
- サーバ、依存関係、権限の追加を避けられる。

### Negative

- 受信完成訳が端末内に永続保存される。
- 保存時刻と原文hashとメッセージIDも保持する。
- 標準10MBの容量上限に達すると新しい保存は失敗する。
- 保存失敗した訳文には5日間保持を保証できない。
- 停止中は期限切れデータを物理削除できない。

## References

- [追加要求 REQ-F-026〜032](../current/REQUIREMENTS.md#9-受信翻訳文の5日間保持案2026-10-05)
- [SPEC-CACHE-001〜004](../current/SPECIFICATIONS.md#14-受信翻訳文の永続キャッシュ案2026-10-05)
- [設計案](../current/DESIGN.md#14-受信翻訳専用の永続キャッシュ案2026-10-05)
- [実装計画](../plans/active/2026-10-05-received-translation-cache.md)
- [ADR-002](002-loopback-offline-privacy-boundary.md)
- [ADR-003](003-service-worker-owns-queue.md)
- [ADR-005](005-extension-document-translation-bridge.md)
- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
