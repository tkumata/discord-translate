# ADR-005: Extension document bridge に翻訳HTTP境界を委譲する

- Status: Accepted, implemented and verified
- Date: 2026-08-18
- Supersedes: ADR-003 for HTTP transport
- Superseded by: None

## Context

実Chromeでは、popupというExtension documentからの`GET /health`は成功する一方、同じExtension originのLocal Network Access許可後もservice workerからの翻訳`POST`はserverへ到達せず、`network_error`となった。sender/input、SHA-256、timeout、fetch拒否のerror境界はNode testで分離済みであり、serverのhealthとCORS preflightも正常である。観測結果は、翻訳jobがservice workerのfetch境界まで進んだ後、HTTP送信前にChromeから拒否されていることを示す。

Chrome公式仕様では、Extensionのservice worker、`chrome-extension://` page、content script間をruntime messagingで接続できる。web originからExtension resourceへnavigationする場合は`web_accessible_resources`の明示が必要で、公開resourceと許可originを限定できる。`MessageSender`はiframe自身のURL、接続元tab、子frame IDを提供する。したがって、Discord top tab内にExtension originの非表示documentを1個置き、HTTP送信だけをそのdocumentへ移せる。

Phase 5.6診断では、実Chrome UIで一部messageが成功し、一部が25秒で`request_timeout`となり、server側で応答write時の`BrokenPipeError`を確認した。ホスト側`/health`はHTTP 200、0.001118秒であり、sandbox内curl失敗をserver停止の証拠とは扱わない。実装確認では`defaultTranslator`のbridge `requestImpl`が無効化され、既定経路がservice worker direct fetchとなっていた。固定7ケースのhost実行は全体で25秒を超えて継続した一方、各成功caseは0.786〜2.131秒、daily単独再実行はHTTP 200、1.371552秒だった。本文・応答は表示・保存していない。

## Decision

ADR-003を次の形で置き換える。

- service workerはsender/input検証、固定API payload構築、FIFO queue、concurrency 1、重複排除、memory cache、job timeout、HTTP statusと最終response schema検証、content scriptへの結果返却を引き続き一意に所有する。
- content scriptはON時に`chrome.runtime.getURL("bridge.html")`をsourceとする非表示iframeをDiscord top frameへ1個だけ追加し、OFF時に削除する。iframeは`hidden`、`aria-hidden="true"`、`tabindex="-1"`とし、Discord UIやaccessibility treeへ参加させない。
- `bridge.html`と`bridge.js`はExtension package内に置く。`web_accessible_resources`はresource `bridge.html`とmatch `https://discord.com/*`の組合せだけを追加する。`bridge.js`、wildcard resource、`externally_connectable`、新しいpermissionは公開・追加しない。
- bridge documentは固定名の`runtime.Port`をservice workerへ接続する。service workerは`port.sender.id === chrome.runtime.id`、`port.sender.url === chrome.runtime.getURL("bridge.html")`、同じExtension origin、整数の`port.sender.tab.id`、子frameを表す正の`port.sender.frameId`を検証する。翻訳依頼元の正規Discord content scriptを検証して得たtab IDと同じbridgeだけへjobを送る。tabごとに1接続だけを採用し、重複接続は切断する。
- bridgeはpageの`window.postMessage`、DOM event、任意URL、外部messageを受理しない。service workerからPort経由で受け取る、service worker自身が構築した固定payloadだけを、定数`http://127.0.0.1:8080/v1/chat/completions`へ`POST`する。method、header、URL、timeoutを呼出側から受け取らない。
- bridgeは120秒でfetchをabortし、JSON serializableなjob ID、HTTP status、200応答のJSONまたは固定error codeだけをservice workerへ返す。service workerのjob監督も120秒へ揃える。非200のbody、例外message、URL、本文、訳文をlog・storageへ出さない。service workerはjob ID、envelope、HTTP status、最終API response schemaを再検証し、成功訳文だけをcache/UIへ渡す。
- bridge未接続、Port切断、重複・未知job ID、bridge envelope不正はservice workerで固定`bridge_unavailable`または`invalid_response`へ正規化する。fetch timeout、LNA拒否、network、HTTP、API schemaの既存固定codeは維持する。
- 同一本文の重複jobは最初にqueueへ入った正規content requestのtab IDに対応するbridgeで1回だけ処理し、既存Promiseを共有する。cache hitはbridgeを使用しない。
- service workerまたはbridgeの終了、iframe削除、tab遷移ではin-flight jobを復旧保存せず固定errorにする。bridge再接続後の新規要求または手動再試行で復旧する。

popupの固定health GETは、LNA許可を利用者操作で取得する入口として維持する。server、CORS origin、host permission、queue/cache値、API payload、新しい依存関係は変更しない。

既定`defaultTranslator`は検証済みbridge registryの`requestImpl`を使用し、service worker direct fetchを既定経路にしない。queue待機120秒は維持し、最大queue待ち120秒+実行120秒=240秒とする。Chromeの単一event/API call上限5分未満に収め、`onMessage`の非同期response channelとlong-lived Port messagingを維持する。120秒は観測された25秒超tailを許容する有限上限であり、永続job、無限待ち、server-side cancellationは追加しない。

## Alternatives considered

### content scriptから翻訳APIを直接fetchする

不採用。Discord originをCORSへ追加する必要があり、Extension origin限定CORSを破る。DOM責務へHTTP、payload、responseを混在させ、page originへ本文通信面を広げる。

### Offscreen APIでhidden documentを作る

不採用。Chromeのoffscreen Reasonには汎用network fetchがなく、`CLIPBOARD`、`DOM_SCRAPING`等を偽って使用できない。`offscreen` permissionの追加も必要になる。

### ChromeのLocal Network Accessを無効化する

不採用。利用者環境のsecurityを下げる解決であり、製品要件に反する。

### service workerのfetchを継続する

不採用。popup health、事前LNA許可、sender修正、error分類後も実Chromeで送信前拒否が再現した。

### localhost server wrapper、proxy、外部依存を追加する

不採用。loopback serverとCORSは正常であり、Chrome内の送信文脈を直すために推論serverや依存を増やす理由がない。

## Consequences

- HTTP実行文脈をLNA成功済みのExtension documentへ合わせつつ、queue/cache/API契約と最終検証をservice workerへ残せる。
- Phase 5.6実装前にclientが25秒で接続を閉じた後にserver生成が完了して`BrokenPipeError`となった連鎖を、観測済みtailが120秒内に完了する限り回避できる。120秒超は従来どおり有限の`request_timeout`とする。実Chromeで翻訳、25秒超・120秒超の境界、`BrokenPipeError`解消を検証済みである。
- `bridge.html`だけがDiscord originからnavigation可能になり、Extensionの存在をpageが観測できる面は増える。bridgeはpage入力を一切受けず、固定localhost request以外を実行しないことで悪用面を限定する。
- Discord pageはiframeを削除できるためavailabilityは保証できない。切断は固定errorと手動再試行で扱い、永続jobや自動無限retryを追加しない。
- 実ChromeでPortのsender field、iframe navigation、Discord CSP下のbridge load、異常系を検証済みであり、security境界を維持した。
- ADR-005の実装によりADR-003のHTTP transport判断を置き換えた。queue/cacheの判断は本ADRへ引き継ぎ、HTTP実行境界だけを変更した。

## Related plans

- [2026-08-18 local Discord translator](../plans/completed/2026-08-18-local-discord-translator.md)

## References

- https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources
- https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/reference/api/runtime
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.chrome.com/blog/local-network-access
