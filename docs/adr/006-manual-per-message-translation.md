# ADR-006: メッセージ単位の手動翻訳を採用する

- Status: Accepted, implemented; Chrome integration unverified
- Date: 2026-08-18

## Context

現行content scriptは、ON中に現在表示中・新規Discordメッセージを検出すると即座にservice workerへ翻訳を依頼する。この方式では利用者が読まないメッセージもqueueへ入り、local modelの処理時間とメモリを消費する。また、ONが翻訳経路の準備状態なのか全件送信の指示なのかがUIから分かりにくい。

popupのLNA health GET、service workerのsender/input検証・queue・cache・固定payload・最終応答検証、tab内Extension document bridgeの固定POST境界はすでに分離されている。翻訳開始の契機だけをcontent scriptで変更でき、API、permission、依存関係、serverを変更する必要はない。

## Decision

ONはbridgeとmessage observerを開始し、現在表示中・新規メッセージごとに`翻訳`buttonを1つ表示する準備状態とする。DOM検出、button生成、bridge生成では翻訳要求を送らない。

利用者が`翻訳`または失敗後の`再試行`を押したときだけcontent scriptからservice workerへ既存の翻訳messageを送る。押下後は`翻訳中…`として重複押下を抑止し、成功時は原文直下へ訳文、失敗時は既存固定error codeと`再試行`を表示する。本文変更・DOM差し替え時は旧結果を破棄し、新本文用の`翻訳`へ戻す。OFFではbuttonを含む挿入UIとbridge/observerを除去し、新規要求を送らない。

翻訳サーバへのPOSTは、button押下から届いた正規要求がservice workerのcache missとして実行される場合だけ、既存の検証済みbridgeから発生する。popup health GETとcache hitはPOSTではない。queue/cache/bridge/API/security境界は変更しない。

## Alternatives considered

### ON中の全メッセージを自動翻訳する

不採用。閲覧しないメッセージにも要求を作り、利用者が翻訳対象を選べない。

### content scriptから翻訳APIへ直接POSTする

不採用。既存のsender/input検証、queue/cache、固定payload、bridge security境界を迂回する。

### popupでメッセージ本文を選択・送信する

不採用。Discord本文と対象DOMの対応をpopupへ広げ、既存のcontent script責務より複雑になる。

## Consequences

- ONだけでは翻訳POSTが発生せず、利用者が対象メッセージを明示的に選べる。
- content scriptとstyles、content script testだけを主に変更し、service worker、bridge、popup、serverは原則変更しない。
- 各メッセージにbuttonを追加するため、Discord DOM変更と仮想scrollに対する重複防止・stale破棄を検証する必要がある。
- cache hitや同一jobのPromise共有では、button押下に対して新しいPOSTが発生しない場合がある。

## Related plans

- [2026-08-18 local Discord translator](../plans/completed/2026-08-18-local-discord-translator.md)

## Supersedes

- なし

## Superseded by

- なし
