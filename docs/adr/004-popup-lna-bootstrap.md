# ADR-004: popup で Local Network Access 許可を bootstrap する

- Status: Accepted, implemented; Chrome UI verification pending
- Date: 2026-08-18
- Supersedes: None
- Superseded by: None

## Context

ChromeのLocal Network Accessはhost permissionやCORSとは別の権限制御である。Extension service workerからlocal network requestを行うにはExtension originが事前に許可済みである必要があるが、service worker自身はpermission promptを表示できない。現行実装はOFF→ON時に`enabled=true`を即時保存してからservice workerが翻訳POSTを行うため、未許可環境ではPOSTがserverへ到達せず、利用者には翻訳失敗しか見えない。

Chrome公式仕様では、popupなどのExtension documentからlocal network requestを発生させることでpermission promptをtriggerできる。既存serverには`GET /health`があり、新endpoint、追加permission、server変更は不要である。

## Decision

OFF→ON操作時だけ、popup documentから定数`http://127.0.0.1:8080/health`へ5秒timeoutのGETを行い、ChromeのLNA promptをtriggerする。checkboxは確認中disabledにし、LNA許可後にHTTP 200かつ追加fieldのないJSON object `{"status":"ok"}`を得た場合だけ`chrome.storage.local.enabled=true`を保存する。

拒否、timeout、network、HTTP、JSON/schema失敗では`enabled=false`を維持し、本文を含まない日本語状態と固定codeだけをpopupに表示する。ON→OFFはhealth確認なしで即時`enabled=false`にする。

popup health GETは唯一のHTTP責務例外とする。Discord本文、訳文、chat completion POST、queue、cache、翻訳response検証は引き続きservice workerだけが所有し、popupは本文・訳文を送受信しない。ADR-003のqueue/cache所有判断は変更しない。

## Alternatives considered

### service workerから最初の翻訳POSTを送り続ける

不採用。workerはpermission promptを表示できず、利用者がLNAを許可する入口がない。

### content scriptからhealthまたは翻訳をfetchする

不採用。Discord DOM責務へHTTPを混在させ、翻訳本文をpage側通信経路へ広げる。

### 新しい権限または独自health endpointを追加する

不採用。既存のlocalhost host permissionと`/health`で足り、Manifestやserverの変更を増やす理由がない。

### ONを先に保存し、healthを非同期確認する

不採用。未許可・server停止中にもcontent scriptがjobを作り、失敗を増やす。

## Consequences

- 利用者操作のあるpopupからLNA promptを表示でき、許可とserver healthを有効化の前提にできる。
- popupはhealthという限定HTTP責務を持つが、翻訳本文・訳文から隔離される。
- server停止、LNA拒否、network失敗ではOFFを維持し、固定codeから原因境界を確認できる。
- `popup.js`の状態遷移をpure export可能な最小構造にし、`extension/tests/popup.test.js`で依存なしのNode testを行う必要がある。
- popup health/stateのNode testは合格した。通常GUIでLNA prompt、health成功後のservice worker POST到達、拒否時OFF、本文非保存を実機検証する必要がある。

## Related plans

- [2026-08-18 local Discord translator](../plans/completed/2026-08-18-local-discord-translator.md)

## References

- https://developer.chrome.com/blog/local-network-access
