# ADR-002: loopback と offline を privacy 境界にする

- Status: Accepted
- Date: 2026-08-18
- Supersedes: None
- Superseded by: None

## Context

Discord本文を外部LLM・翻訳APIへ送らないことが最重要要求である。一方、Qwen modelの初回downloadにはHugging Face Hub接続が必要であり、Chrome Extensionからlocal HTTP APIを呼ぶにはCORSとhost permissionが必要になる。CORSだけでは同一Mac上の別processを認証できない。

## Decision

privacy境界を次の組合せで定義する。

- serverは明示的にIPv4 `127.0.0.1`だけでlistenする。
- CORSは1つの実`chrome-extension://<EXTENSION_ID>`だけを許可する。
- modelは固定の非機密入力で初回cacheし、通常起動は`HF_HUB_OFFLINE=1`とtelemetry無効を強制する。
- Discord本文、prompt、responseをファイル、DB、通常ログへ保存しない。
- Extensionのhost permissionは`http://127.0.0.1:8080/*`だけにする。
- CORSをauthenticationと表現せず、同一Mac上の別processをtrusted local boundary内として扱う。

## Alternatives considered

### `0.0.0.0`またはLAN IPでlistenする

不採用。単一Mac内利用に不要で、LANからの到達可能性を増やす。

### localhost API tokenを追加する

現時点では不採用。同一ユーザーのlocal browserとprocessだけが対象であり、token配布・保存を追加する脅威モデル上の根拠がない。Mac上の別processを信頼できない要件に変わった場合は再評価する。

### 起動時にHubへ接続可能な状態を維持する

不採用。通常翻訳にnetwork接続は不要で、誤ったmodel取得や外部通信の余地を残す。

### DEBUGログで詳細を保存する

不採用。入力・出力本文の漏えいリスクが製品目的に反する。

## Consequences

- LAN・internetからの到達面と通常時の外部通信を小さくできる。
- 初回model取得を明示的な別手順として行う必要がある。
- cacheにないmodelを指定したoffline起動は失敗する。
- CRITICAL logは本文漏えいを抑える代わりにserver障害の可観測性を下げる。
- CORSとloopbackはlocal malwareや同一ユーザーprocessからの呼出しを防がない。
- 実Chrome LNA、LAN別端末拒否、不正JSON privacy markerは未検証であり、受け入れ完了ではない。

## Related plans

- [2026-08-18 local Discord translator](../plans/completed/2026-08-18-local-discord-translator.md)

## References

- https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables
- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/blog/local-network-access
