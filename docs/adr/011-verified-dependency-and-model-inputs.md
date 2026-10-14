# ADR-011 依存関係とモデルの取得を固定・検証する

## Status

Accepted — 2026-10-14。ユーザの「OK. 進めて。」で実装を承認。
ユーザはローカル翻訳と ChatGPT 翻訳の維持を選択した。
取得方法の変更は、承認済み実装計画の Task 1〜4 で実施する。
既存 ADR の承認状態は変更しない。
2026-10-14、ユーザが動作確認の完了を報告した。
今回の実 Chrome 受け入れを合格とし、開発を完了する。
個別操作と異常系の実機試験内訳は未報告である。

## Context

利用者はサプライチェーン攻撃への耐性を求めている。
利用者は非推奨技術の使用を禁止している。
攻撃への完全な免疫は保証できない。

現在の拡張機能には npm の外部依存がない。
ChatGPT 補助も Node.js の標準機能だけを使う。
Python は `mlx-lm==0.31.3` だけを直接固定している。
Python の間接依存と配布物のハッシュは固定していない。
モデルの取得手順は可変の Hub リポジトリ名を使う。
通常起動のオフライン設定だけでは取得物を検証できない。

Manifest V3 と Native Messaging は現行の公式機能である。
hidden bridge は同梱 iframe であり、Offscreen API ではない。
今回の調査では hidden bridge の非推奨指定を確認していない。
確認した既知の非推奨 API 候補は実行コードに見つからなかった。
全 API と全間接依存の検査は未実施である。

## Decision

MUST は必須、SHOULD は推奨、MAY は任意を表す。

- MUST: ローカル翻訳と ChatGPT 翻訳を維持する。
- MUST: 拡張機能と ChatGPT 補助の npm 外部依存をゼロに保つ。
- MUST: 既存の公式 MLX サーバと通信の責務配置を維持する。
- MUST: Python の直接依存と間接依存のバージョンを固定する。
- MUST: 許可する各 wheel の SHA-256 を追跡対象に記録する。
- MUST: 導入は `--require-hashes --only-binary=:all:` を使う。
- MUST: 配布元は PyPI に限定し、追加 index と VCS 依存を禁止する。
- MUST: 導入処理は環境変数と設定による配布元の上書きを遮断する。
- MUST: 対応 wheel がない場合は導入を停止する。
- MUST: 導入はプロジェクト専用の新規 venv で検証する。
- MUST: Python と pip の取得元と使用版を導入記録へ残す。
- MUST: Python の取得元は公式配布または検証可能な管理元とする。
- MUST: pip の初期導入は信頼した Python の `ensurepip` を使う。
- MUST: pip を更新する場合も配布物の版とハッシュを検証する。
- MUST: 通常の導入経路から source build を起動しない。
- MUST: モデルはリポジトリ名と完全な commit ID で固定する。
- MUST: モデル台帳は読込み対象ファイル名と SHA-256 を列挙する。
- MUST: モデル取得処理は台帳のファイルだけを保存する。
- MUST: 重みは safetensors 形式に限定する。
- MUST: モデル取得処理は Python コードと pickle 形式を拒否する。
- MUST: モデルと tokenizer の `trust_remote_code` を無効にする。
- MUST: 通常起動は検証したモデルのローカルパスだけを使う。
- MUST: 起動処理は読込み対象ファイルのハッシュを照合する。
- MUST: 不一致や不足がある場合は、推論の起動前に停止する。
- MUST: 通常起動は依存導入、モデル取得、自動更新を行わない。
- MUST: 通常起動は既存のオフライン設定を維持する。
- MUST: 更新時は依存差分、由来、保守状況、公開勧告を確認する。
- MUST: ハッシュの生成だけを安全性の証明として扱わない。
- MUST: 更新版は回帰検証後に採用し、直前の台帳を保持する。
- MUST: EOL の実行環境と公式に非推奨の API を採用しない。
- MUST: 導入時と更新時に、公式文書で保守状況を再確認する。
- MUST: 非推奨の間接依存が必須なら、採用を停止して代替案を提示する。
- MUST: Extension pages の CSP は同梱 script と固定 loopback に限定する。
- MUST: 配布・導入手順は信頼したソースの commit を記録する。
- MUST: Native host の登録前に実行パスと対象 commit を確認する。
- SHOULD: 運用者は月次で保守状況と公開セキュリティ勧告を確認する。

現在の package.json は ESM 設定に必要なため保持する。
追加のパッケージ管理ツールとビルド工程は導入しない。
CI、署名基盤、常駐の更新サービスは追加しない。

MLX CLI は `trust_remote_code` に None を渡す。
フラグ省略を明示的な False の指定とは扱わない。
起動前に `model_file`、`auto_map` と custom tokenizer 指定を拒否する。
固定したデータと組込み実装だけを許可する。
標準入力は `/dev/null` とし、対話でのコード実行許可を禁止する。
公式サーバの API と内部実装は変更しない。
拡張の固定 payload は任意モデルと adapter を受け付けない。
同一端末の任意 HTTP 要求を排除する境界にはしない。

## Alternatives

### Option A: 翻訳機能を別言語や別ランタイムへ全面移行する

- 利点: Python の依存を削減できる可能性がある。
- 欠点: 別の推論エンジンと配布物への依存が生じる。
- 欠点: 翻訳品質と既存機能の再検証範囲が広い。

### Option B: バージョン固定と脆弱性スキャンだけを追加する

- 利点: 導入手順の変更量が小さい。
- 欠点: 配布物の差替えとモデルの更新を固定できない。
- 欠点: 未知の悪意あるコードを検出する保証がない。

### Option C: Python とローカル翻訳を削除する

- 利点: Python とモデルの供給経路を削除できる。
- 欠点: ユーザが選択した両翻訳先の維持に反する。

## Rationale

現在の npm 依存ゼロという利点を維持する。
対策は未固定の外部入力と導入手順に集中する。
ハッシュ照合は承認した配布物との一致を判定する。
採用時の確認は配布物の由来と既知の問題を判定する。
役割の異なる二つの確認を更新手順に組み込む。

## Consequences

### Positive

- 新規導入時の依存解決による意図しない更新を抑止する。
- 固定後に変更された配布物とモデルを拒否する。
- 通常起動から外部コードを追加取得する経路を除く。
- モデルと依存の更新内容をレビューできる。

### Negative

- 更新時に台帳の作成と回帰検証が必要になる。
- wheel が揃わない環境では導入できない。
- モデルの全ファイル照合に起動時間が必要になる。
- 既存の任意 `MODEL` 指定は台帳に登録したモデルへ制限される。
- 既存キャッシュは移行時に検証する必要がある。

信頼の起点は、運用者が確認したソースと台帳である。
悪意のある依存を初回採用するリスクは残る。
署名やハッシュも配布者自身の侵害を排除しない。
Chrome、OS、Python、Node.js、モデル parser の欠陥は残る。
OpenAI 側のサービス侵害はローカルの固定では防げない。
同一ユーザ権限でソースと台帳を改変する攻撃は防御範囲外である。
ソース同梱の照合処理は、その攻撃への独立した信頼の起点ではない。

## References

- [実装計画](../plans/active/2026-10-14-supply-chain-hardening.md)
- [現在の要件](../current/REQUIREMENTS.md)
- [現在の仕様](../current/SPECIFICATIONS.md)
- [現在の設計](../current/DESIGN.md)
- [ADR-001: 公式 MLX サーバ](001-use-official-mlx-lm-server.md)
- [ADR-005: Extension document bridge](005-extension-document-translation-bridge.md)
- [ADR-009: 翻訳先の選択](009-chatgpt-plan-translation.md)
- [ADR-010: Native Messaging](010-native-messaging-startup.md)
- [pip: Secure installs](https://pip.pypa.io/en/stable/topics/secure-installs/)
- [Hugging Face: Download files](https://huggingface.co/docs/huggingface_hub/en/guides/download)
- [Chrome: CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- [Chrome: Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Node.js: Releases](https://nodejs.org/en/about/previous-releases)
- [Python: Supported versions](https://devguide.python.org/versions/)
- [MLX-LM 0.31.3: model loading](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/utils.py)
- [PyPI: JSON metadata と脆弱性情報](https://docs.pypi.org/api/json/)
- [OSV: Version query API](https://google.github.io/osv.dev/api/)

公式文書の確認日: 2026-10-14。
