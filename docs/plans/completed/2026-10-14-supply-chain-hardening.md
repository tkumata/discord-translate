# 依存関係とモデルのサプライチェーン対策

## Status

- Phase: completed
- Approval: approved (2026-10-14、ユーザの「OK. 進めて。」)
- 作成日: 2026-10-14
- 確定したユーザ選択: ローカル翻訳と ChatGPT 翻訳を維持する。
- 実施範囲: Task 1〜4 の実装と検証。
- 実装と自動・実モデル・実 API・隔離 Chrome の検証は完了。
- ユーザの動作確認完了報告により、今回の実 Chrome 受け入れを合格とする。
- 2026-10-14、ユーザの指定により Task 1〜4 と本変更を完了とする。
- 個別操作と異常系の実機試験内訳は未報告である。
- active plan の配置を維持する。

## Goal

外部依存とモデルの供給経路から入る不正コードのリスクを減らす。
既存の翻訳機能を維持し、非推奨技術を使用しない。
攻撃の影響を完全にゼロにする保証は目標に含めない。
承認済み判断は [ADR-011](../../adr/011-verified-dependency-and-model-inputs.md) に記録する。

## Scope

- `requirements.txt` の全依存・配布物ハッシュ固定。
- モデル台帳 `models.lock.json` の新設。
- `scripts/` 内の導入・取得・モデル検証処理。
- `scripts/start-server.sh` と `server.sh` の検証済みモデルへの移行。
- `extension/manifest.json` の明示的な CSP。
- 依存と通信の方針検査、および異常系の動作テスト。
- README と現在の要件・仕様・設計の承認範囲の更新。
- 既存 Native host 登録手順への由来と実行パスの確認追加。

新規の処理は既存の Python、Bash、Node.js 標準機能で実装する。
モデル取得は固定済みの既存 `huggingface_hub` を使用する。
通常起動の検証処理は Python の標準機能を使用する。

## Non-goals

- ローカル翻訳または ChatGPT 翻訳の削除。
- 推論エンジン、認証方式、通信経路の全面移行。
- 新しい npm 依存、パッケージ管理ツール、ビルド工程の導入。
- CI、コード署名基盤、自動更新サービスの新設。
- 全依存のソース監査と未知の脆弱性がないことの証明。
- OS や同一ユーザ権限の侵害に対する保護。
- 無関係な既存文書の整備と完了記録の再編集。

## Required Behavior

MUST は必須、SHOULD は推奨、MAY は任意を表す。

### 現状の確認結果

| 対象 | 確認した事実 | 不足または確認限界 |
| --- | --- | --- |
| 拡張機能と ChatGPT 補助 | npm の外部依存ゼロ。ビルド不要。 | 将来の依存追加を検出する運用がない。 |
| Python | `mlx-lm==0.31.3` の直接固定。 | 間接依存と配布物のハッシュが未固定。 |
| モデル取得 | Hub のリポジトリ名を使用。 | commit ID とファイルハッシュが未固定。 |
| 通常起動 | offline、telemetry 無効、loopback bind。 | 読込み対象の完全性を検証しない。 |
| Native host | Node とソースの絶対パスを登録。 | 登録元の commit 確認手順がない。 |
| Chrome | Manifest V3 と同梱 iframe bridge。 | CSP は Chrome の既定値に依存する。 |
| 非推奨 API | 既知候補の検索で実行コードの該当なし。 | 全 API と間接依存の判定は未実施。 |

調査時の作業ツリーは clean だった。
CI、依存 lockfile、配布用ビルドは確認できなかった。
下書き更新は合成 `beforeinput` の受理後に実際の本文を照合する。
非推奨 API への置換は行わない。
Discord 側のイベント受理は実 Chrome で確認する。

### 保持する動作

- MUST: 両翻訳先、明示選択、手動翻訳、自動投稿の禁止を維持する。
- MUST: worker の入力検証、FIFO、上限、timeout を維持する。
- MUST: bridge は固定 loopback HTTP と SSE を所有する。
- MUST: 途中訳の失敗処理と古い結果の破棄を維持する。
- MUST: provider 別 cache と受信完成訳の 120 時間保持を維持する。
- MUST: ローカルの CORS、offline、telemetry 無効を維持する。
- MUST: ChatGPT の OAuth 検証とトークン保護を維持する。
- MUST: Native Messaging は起動・停止用の現行境界を維持する。
- MUST: 既存の本文、訳文、トークンのログ出力禁止を維持する。

### 変更後の取得・起動・更新

| ID | レベル | 要求 |
| --- | --- | --- |
| SC-001 | MUST | 通常の導入は全 Python 依存の版と wheel の SHA-256 を検証する。 |
| SC-002 | MUST | 導入は追加 index、VCS、source build を使わない。 |
| SC-003 | MUST | モデル台帳は repo ID、完全な commit ID、ファイル名、SHA-256 を保持する。 |
| SC-004 | MUST | 取得は台帳の許可ファイルだけを保存する。 |
| SC-005 | MUST | 起動は台帳と一致するローカルモデルだけを読む。 |
| SC-006 | MUST | モデル不足・不一致では推論前に非ゼロで停止する。 |
| SC-007 | MUST | 通常起動はモデル取得、依存導入、自動更新を行わない。 |
| SC-008 | MUST | モデル由来のコード実行と pickle 重みを拒否する。 |
| SC-009 | MUST | npm 外部依存ゼロと同梱コードだけの実行を維持する。 |
| SC-010 | MUST | 非推奨 API と EOL 実行環境を採用しない。 |
| SC-011 | MUST | 更新は由来、差分、保守状況、公開勧告を確認してから採用する。 |
| SC-012 | MUST | 信頼したソースの commit と実行環境の取得元・版を記録する。 |

起動入力 `MODEL` は、台帳に登録したモデルの識別に限定する。
未登録の Hub 名と任意パスは拒否する。
別モデルの使用には台帳への登録と検証が必要になる。
既存キャッシュの再利用時も、独立に確認した台帳と照合する。
不一致時の自動再取得や別モデルへの切替は行わない。
更新前の台帳と取得済み資産は、復旧用に保持できる。
既知の危険がある旧版への復旧は安全な復旧として案内しない。

モデル台帳と依存台帳は、信頼した Git commit の一部として確認する。
取得したファイルのハッシュを記録するだけでは由来を証明できない。
配布元の確認と公開された配布物情報の照合を採用手順に含める。
同一ユーザによる台帳と実行コードの同時改変は防げない。
モデル parser の欠陥と採用済み配布物の悪意は残存リスクとする。

Extension pages の CSP は以下を基本とする。

```text
script-src 'self'; object-src 'none';
connect-src http://127.0.0.1:8080 http://127.0.0.1:8766;
```

popup と bridge の正常通信は実 Chrome で検証する。
外部の認証画面を開く操作と API への fetch は区別する。
CSP は Native host や Discord のページ本体には適用されない。
不足がある場合も外部 script や `unsafe-eval` は許可しない。

### 採用対象と確認限界

- 採用環境は CPython 3.14 / macOS 26+ / arm64 とする。
- 新規導入の検証版は CPython 3.14.8 / pip 26.2.1 である。
- Node.js の基準環境は 24 LTS とする。
- Node.js 22 は現時点で LTS であり、非推奨と扱わない。
- 導入記録には使用したパッチ版も残す。
- 全 34 依存の対象 wheel を PyPI から取得し、hash を検証した。
- Chrome は公式サポート中の Stable を使う。
- 非推奨判定は公式文書とパッケージの保守情報で確認する。
- 版が古いという理由だけで非推奨と断定しない。

起動設定のモデルは `mlx-community/Qwen3.5-9B-MLX-4bit` である。
README の確認済み環境と旧仕様には Qwen3-8B の記載が残る。
固定対象は現行起動設定の Qwen3.5-9B とする。
モデルの置換や品質改善は追加しない。
既定キャッシュの `refs/main` は以下の値だった。

```text
938d8919941c6e7efd3c7150eff7fe9d12afa631
```

固定 commit の Hub metadata と全 11 ファイルを照合した。
LFS 資産は公開 SHA-256 と照合した。
通常ファイルは固定 commit の Git blob ID と照合した。
台帳には各ファイルの SHA-256 とサイズを記録した。
照合は配布元自身の侵害がないことの証明ではない。

## Tasks

### Task 1: Python の導入物を固定する

- Result: 実装・検証済み (2026-10-14)。
  - 既存の全 34 依存の版を維持し、対象 wheel の SHA-256 を固定した。
  - PyPI metadata の対象配布物、yanked、保守分類を確認した。
  - PyPI と OSV の公開情報で対象版の脆弱性情報の該当はなかった。
  - 全依存のソース監査と全 API の非推奨監査は実施していない。
  - Homebrew の Python 3.14.8 の導入記録を確認した。
  - 同梱 `ensurepip` は pip 26.2.1 だった。
  - 新規の検証用 venv へ正式手順で導入し、`pip check` が成功した。
  - 導入元、版、source commit、dirty 状態、台帳 hash の記録を確認した。
  - 既存のプロジェクト `.venv` は変更していない。
  - 実 pip の fixture で正常導入と以下の拒否を確認した。
  - 拒否対象は hash 不一致、hash 不足、未固定の間接依存、source のみの配布物。
  - 環境変数と設定ファイルの上書き遮断は環境構築関数の test で確認した。

- Objective: SC-001、002、010、012 を満たす導入経路を作る。
- Scope:
  - `requirements.txt`、`scripts/` の導入処理と対応テスト。
  - Python 3.14 / macOS arm64 の wheel と全依存の確認。
  - Python、pip、依存の由来・版・保守状況の記録。
- Acceptance Criteria:
  - 全依存の版と許可 wheel の SHA-256 が追跡される。
  - 新規 venv で hash 検証付きの導入と `pip check` が成功する。
  - hash 不一致、未固定依存、wheel 不足は導入を失敗させる。
  - 失敗時も source build と追加 index へ切り替えない。
  - 環境変数と設定ファイルで配布元を上書きできない。
  - パッケージ管理ツールと npm 依存を追加しない。
- Verification:
  - 一時 venv で正式な導入コマンドを実行する。
  - テスト配布物で hash 改変と不足の拒否を確認する。
  - 追加 index の環境変数と設定を与え、使用されないことを確認する。
  - 採用する全依存の保守情報と公開勧告を確認する。
  - wheel 不足または必須依存の非推奨がある場合は採用を停止する。

### Task 2: モデルを固定し、検証後だけ起動する

- Result: 実装・検証済み (2026-10-14)。
  - モデル台帳は固定 commit の 11 ファイルを対象とする。
  - 既存 Hub snapshot を新しい `models/` へコピーし、全 hash を照合した。
  - 既存 Hub snapshot は変更していない。
  - 全ファイルの再照合時間は 2.211 秒だった。
  - 実 Tokenizer は `trust_remote_code=False` で組込み実装として読めた。
  - 起動に使う公式 CLI は None を渡すため、明示 False の設定とは記録しない。
  - `model_file` 等の指定拒否と非対話実行で通常起動のコード参照を閉じた。
  - fixture で改変、不足、余分なファイル、外逸 symlink、不正パスを拒否した。
  - hash が一致しても動的コード指定を持つ config は拒否した。
  - 起動テストで検証失敗後にサーバが実行されないことを確認した。
  - 新規 venv と検証済みモデルで公式サーバの起動を確認した。
  - sandbox 内の起動は Metal が使えず失敗した。
  - 承認された制限外実行で同じ起動処理と実モデル検証が成功した。
  - 遠隔からの全重み再取得は行わず、固定元情報と既存資産を照合した。

- Objective: SC-003〜008 を満たすモデルの取得・読込みに変更する。
- Scope:
  - `models.lock.json`、取得・検証処理と対応テスト。
  - `scripts/start-server.sh`、`server.sh`。
  - `MODEL` の台帳内選択と既存キャッシュの移行。
- Acceptance Criteria:
  - モデル台帳に承認対象の全ファイルを列挙する。
  - 取得結果が commit ID と SHA-256 に一致する。
  - 重みは safetensors に限定し、remote code を許可しない。
  - 改変、不足、未登録モデルではサーバを起動しない。
  - 不正パスとモデル領域外を参照する symlink を拒否する。
  - 検証済みローカルパスで起動し、通常時は取得しない。
  - キャッシュ移行は検証前のファイルを推論へ渡さない。
  - 起動時の全ファイル照合時間を実測して記録する。
- Verification:
  - 小さな fixture で正常、改変、不足、不正パスを検証する。
  - 起動テストは検証失敗後に MLX を実行しないことを確認する。
  - Task 1 後に実モデルの完全性と offline 起動を確認する。
  - 実モデルの採用確認と fixture の異常系検証を区別する。

### Task 3: 拡張機能の依存と実行コードの方針を固定する

- Result: 完了。実装・自動検証・隔離 Chrome とユーザ受け入れを確認済み。
  - Node.js 24.21.0 で既存を含む 103 件の test が成功した。
  - 外部 npm 依存ゼロ、ESM、Manifest V3、CSP、host 権限を検査する。
  - 新しい source、テスト、導入処理に非推奨 API は追加していない。
  - 既存コードの既知の非推奨候補の検索では該当がなかった。
  - Chrome for Testing 151.0.7922.34 の隔離プロファイルで検証した。
  - 検証は実際の拡張ディレクトリと Manifest を読み込んだ。
  - popup context の同梱 module と両 loopback GET が成功した。
  - 外部 fetch は `connect-src` による拒否を確認した。
  - 外部 script は `script-src-elem` による拒否を確認した。
  - loopback 応答は検証用 server であり、Discord の受け入れではない。
  - 2026-10-14、ユーザは動作確認の完了を報告した。
  - 今回の実 Chrome 受け入れを合格とする。
  - 下書き編集と Native 自動起動の個別試験内訳は未報告である。

- Objective: SC-009、010 を満たし、既存の依存ゼロを維持する。
- Scope:
  - `extension/manifest.json`、方針検査、対応テスト。
  - 実行コードの使用 API と公式の非推奨情報の照合。
  - Node.js LTS と現行 Chrome での既存テスト。
- Acceptance Criteria:
  - Extension pages が明示的な CSP を持つ。
  - 同梱 script と両 loopback への通信が動作する。
  - Extension pages から外部コードと外部 fetch が拒否される。
  - 外部 npm 依存の追加を検査で検出する。
  - 既存の package.json の ESM 設定を維持する。
  - 非推奨 API を検出した場合は、代替と互換性を記録する。
  - 未承認の機能削除や権限追加を行わない。
- Verification:
  - `npm --prefix extension test` を実行する。
  - 変更した JavaScript の `node --check` を実行する。
  - Chrome で CSP による外部通信拒否を確認する。
  - Chrome で popup、bridge、下書き編集、Native 接続を確認する。
  - DOM の模擬テストだけで Chrome 受け入れを合格にしない。

### Task 4: 更新手順と既存機能の回帰を確認する

- Result: 完了。文書・自動・実モデル・実 API とユーザ受け入れを確認済み。
  - README と現在の要件・仕様・設計を更新した。
  - 取得元、更新差分、公開勧告、EOL、非推奨、復旧の手順を記載した。
  - Native host 登録前の commit と Node 実行パス確認を記載した。
  - Python の追加 test 8 件と既存 `verify.py --self-check` が成功した。
  - 実モデルの health、CORS、SSE、KV cache、固定 6 ケースが成功した。
  - 実モデルの追加直列 2 件も成功した。
  - ローカルの固定文による投稿用英訳が正常完了した。
  - 稼働中の補助を再利用し、実 ChatGPT の固定文の日訳・英訳が成功した。
  - 実 API の検証は本文・訳文・tokens を出力・保存していない。
  - 既存の補助を停止せず、認証や Native 登録を変更していない。
  - queue、保存期限、認証と古い結果の破棄は既存の自動 test が成功した。
  - ユーザの「動作確認しました完了としましょう」を受け、開発を完了する。
  - 実 Chrome 受け入れの根拠は今回のユーザ報告とする。
  - 翻訳先切替、受信、下書き、自動起動の個別試験内訳は未報告である。
  - 完了記録は文書だけの変更とし、成功済みの検証は再実行しない。

- Objective: SC-011、012 と両翻訳先の互換性を確認する。
- Scope:
  - README と `docs/current/` の関連要求・仕様・設計。
  - 台帳更新、取得、検証、起動、復旧の運用手順。
  - Native host 登録元の commit と実行パスの確認手順。
- Acceptance Criteria:
  - 手順に由来、差分、非推奨、EOL、公開勧告の確認がある。
  - 通常起動と依存・モデルの更新を別操作として記載する。
  - 新規導入と既存キャッシュ移行の両方を検証する。
  - 両翻訳先の受信翻訳と下書き翻訳が動作する。
  - queue、失敗処理、保存期限、認証情報の境界を維持する。
  - 自動、実モデル、実 API、実 Chrome の結果を分けて記録する。
  - 未確認範囲と残存リスクを成功扱いしない。
- Verification:
  - Task 1〜3 の完了を前提とする。
  - 差分全体で既存の Node テストと Python self-check を実行する。
  - 実モデルで `scripts/verify.py --streaming` を実行する。
  - 固定文で ChatGPT の日訳・英訳と認証維持を確認する。
  - 実 Chrome で切替、受信、下書き、再読込、自動起動を確認する。
  - `git diff --check` と変更範囲の確認を行う。
  - 同一差分で成功済みの検証は、追加の懸念がなければ再実行しない。

## Open Questions

ユーザへの未解決の質問はない。
全依存の固定とモデル資産の照合は完了した。
ユーザの動作確認報告により、Task 4 の操作受け入れは合格とする。
今回の開発に残件はない。
残存リスクと既存の未検証範囲は、追加検証済みとは扱わない。
採用条件を満たさず設計変更が必要な場合は、再承認を求める。

## References

- [ADR-011](../../adr/011-verified-dependency-and-model-inputs.md)
- [要件](../../current/REQUIREMENTS.md)
- [仕様](../../current/SPECIFICATIONS.md)
- [設計](../../current/DESIGN.md)
- [依存定義](../../../requirements.txt)
- [起動処理](../../../scripts/start-server.sh)
- [Manifest](../../../extension/manifest.json)
- [Native host 登録](../../../scripts/install-native-host.mjs)
- [pip: Secure installs](https://pip.pypa.io/en/stable/topics/secure-installs/)
- [Hub: 固定 revision と取得ファイル選択](https://huggingface.co/docs/huggingface_hub/en/guides/download)
- [Chrome: CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- [Chrome: Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Node.js: サポート状況](https://nodejs.org/en/about/previous-releases)
- [Python: サポート状況](https://devguide.python.org/versions/)

- [PyPI: JSON metadata](https://docs.pypi.org/api/json/)
- [OSV: API](https://google.github.io/osv.dev/api/)

公式文書と公開 metadata の確認日: 2026-10-14。
