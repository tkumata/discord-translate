# Architecture Decision Records

このディレクトリは長期的な変更コストを持つ設計判断の正本である。現在要求は [要件定義書](../current/REQUIREMENTS.md)、外部仕様は [仕様書](../current/SPECIFICATIONS.md)、完了した実装履歴は [completed plan](../plans/completed/2026-08-18-local-discord-translator.md) を参照する。

## Index

| ADR | Status | Date | Decision |
|---|---|---|---|
| [ADR-001](001-use-official-mlx-lm-server.md) | Accepted | 2026-08-18 | 独自wrapperを追加せず、公式`mlx_lm.server`を直接使う。 |
| [ADR-002](002-loopback-offline-privacy-boundary.md) | Accepted | 2026-08-18 | loopback bindと通常時offlineをprivacy境界にする。 |
| [ADR-003](003-service-worker-owns-queue.md) | Accepted, implemented; superseded for HTTP transport by ADR-005 | 2026-08-18 | Extension service workerがqueue、cache、payload、最終検証を所有する。 |
| [ADR-004](004-popup-lna-bootstrap.md) | Accepted, implemented; Chrome UI verification pending | 2026-08-18 | popupの固定health GETでLNA許可をbootstrapする。 |
| [ADR-005](005-extension-document-translation-bridge.md) | Accepted, implemented and verified | 2026-08-18 | queue/cache/検証をservice workerに残し、翻訳HTTPだけをタブ内Extension document bridgeへ委譲する。 |
| [ADR-006](006-manual-per-message-translation.md) | Accepted, implemented and verified | 2026-08-18 | ON中は各メッセージに翻訳buttonを置き、押下時だけ既存経路へ翻訳を依頼する。 |
| [ADR-007](007-streaming-translation.md) | Accepted, implemented; Chrome verified by user | 2026-10-02 | 既存bridgeのSSEと要求用Portで生成中の訳文を順次表示し、最終検証後だけ確定する。 |

Qwen3.5採用、queue 2、FastAPI/Flask、launchdの詳細は未決定であり、現時点ではADRを作成しない。
