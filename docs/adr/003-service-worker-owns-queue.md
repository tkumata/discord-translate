# ADR-003: Extension service worker が queue と cache を所有する

- Status: Accepted, implemented; superseded for HTTP transport by ADR-005
- Date: 2026-08-18
- Supersedes: None
- Superseded by: ADR-005

## Context

Discordでは複数メッセージが短時間に追加され得るが、local model serverへ大量並列要求を送ると結果混線、hang、memory増加のriskがある。content scriptはpage contextとDOMを所有する一方、cross-origin localhost fetchにはExtension host permissionが必要である。cacheはDiscord messageと表示状態に近い場所で扱う方がserverを汎用のまま保てる。

## Decision

Chrome Extension service workerが次を一箇所で所有する。

- localhost APIへの`fetch`
- 受け付け順の有限queue
- 初期concurrency 1
- timeoutとHTTP/schema/thinking/truncation検証
- job識別子と結果の対応
- 翻訳cache

初期値を次に固定する。

- concurrency 1、runningを含むunique job上限64、queue待機期限120秒
- fetch timeout 25秒
- trim済み本文のSHA-256をkeyにする同一queued/running jobのPromise共有
- 成功訳文だけを最大256件・30分保持するmemory LRU cache
- service worker停止時はqueue、in-flight、cacheを破棄し、本文・訳文を復旧保存しない
- DOM削除や本文変更ではworker側jobをcancelせず、content scriptがstale結果を破棄する

content scriptはDiscord DOMと表示だけを所有し、`chrome.runtime.sendMessage`でservice workerへ依頼する。server側cacheは追加しない。queue 2はqueue 1の結合・stress試験に合格し、明確なthroughput改善がある場合だけ別判断で採用する。

保存するExtension状態はbooleanの`enabled`だけとし、本文、訳文、job、cacheを`chrome.storage`へ保存しない。

## Alternatives considered

### content scriptからlocalhostを直接fetchする

不採用。page originの制約とHTTP責務がDOM処理へ混在し、複数content contextのqueue所有者が曖昧になる。

### server側queueとcacheに集約する

不採用。Discord message lifecycleと無関係なserverへ製品固有状態を持ち込み、独自wrapperの理由を作る。公式serverのconcurrency 1は防御として併用するが、製品job queueの代替にはしない。

### concurrency 2から開始する

不採用。安定性を優先する要件に反し、改善量とmemory影響が未測定である。

### cacheを追加しない

不採用。原依頼どおりcacheはExtensionに置く。ただし永続cacheや高度なevictionは要求せず、短時間の再描画と同一本文の重複翻訳を避けるmemory LRUだけとする。

### queueとcacheをstorageへ復旧可能に保存する

不採用。Manifest V3 service workerの再起動には強いが、本文・訳文の永続化禁止に反する。終了時の未完了jobは失敗表示と手動再試行で復旧する。

## Consequences

- HTTP、queue、cacheの状態所有者が一意になり、content scriptをDOM責務に限定できる。
- service worker停止・再起動時はin-flight jobとcacheが失われ、利用者の手動再試行が必要になる。
- concurrency 1ではburst時に待ち時間が増える。
- serverをDiscord固有状態から独立させ、独自wrapperを避けられる。
- Extension service workerのqueue/cacheとNode自動検証は実装済みである。Discord実UI、実Extension IDのCORS/LNA、service worker lifecycleの実機妥当性は未検証である。

## Related plans

- [2026-08-18 local Discord translator](../plans/completed/2026-08-18-local-discord-translator.md)

## References

- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/reference/api/storage
