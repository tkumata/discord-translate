# ADR-001: 公式 mlx_lm.server を直接利用する

- Status: Accepted
- Date: 2026-08-18
- Supersedes: None
- Superseded by: None

## Context

個人用local translation APIにはOpenAI風chat completion、model load、CORS、loopback bindが必要である。`mlx-lm v0.31.3`の公式serverは `POST /v1/chat/completions`、host/port、allowed origins、Qwen thinking無効化、prompt/decode concurrencyを提供する。独自serverはrequest validationやprompt固定を追加できる一方、依存、保守、ログ漏えい、API差異を増やす。

公式serverはproduction向け汎用serverとして推奨されていない。本製品は単一ユーザー・loopback限定であり、この境界を広げない。

## Decision

`mlx_lm.server`を`./scripts/start-server.sh`から直接`exec`する。独自HTTP server、FastAPI、Flaskは追加しない。翻訳prompt、response validation、queue、cacheはChrome Extension側で所有する。

次のいずれかが実機で再現し、公式設定またはExtensionで解消できない場合だけ本ADRを置き換える計画を作る。

- 実Extension originへCORSを安全に限定できない。
- 必須のserver-side request validationまたはqueueがある。
- 必要な可観測性と本文非ログを両立できない。
- Chromeからの直接利用が公式API仕様上成立しない。

## Alternatives considered

### FastAPI/Flask wrapper

不採用。現時点の要求を満たすための追加依存と重複HTTP実装になり、実測上の必要がない。

### Python標準ライブラリによるwrapper

不採用。framework依存は避けられるが、server lifecycle、proxy、validation、error mappingを自前で保守する必要があり、現状は不要である。

### MLX-LMをlibraryとして直接呼ぶ独自server

不採用。model loadとgeneration queueまで再実装することになり、公式serverを使う目的に反する。

## Consequences

- コードと依存を最小化でき、公式CLI/APIの更新に追従しやすい。
- server固有のAPI部分互換性、既知issue、logging挙動を受け入れる。
- server側で製品固有promptを強制できないため、Extensionからのpayloadを信頼する単一ユーザー境界となる。
- CORSは認証ではなく、同一Macの別processを防がない。
- 利用範囲をLAN、多ユーザー、productionへ拡大する場合は本判断を再評価する。

## Related plans

- [2026-08-18 local Discord translator](../plans/completed/2026-08-18-local-discord-translator.md)

## References

- https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/SERVER.md
- https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/server.py
- https://github.com/ml-explore/mlx-lm/releases/tag/v0.31.3
