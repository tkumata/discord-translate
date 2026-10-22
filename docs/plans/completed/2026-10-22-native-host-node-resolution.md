# Issue #1: Node.js 更新後も自動起動を維持する

## Status

- Phase: completed
- Approval: approved (2026-10-22、ユーザの「OK. 進めてください。」)
- 対象 Issue: [#1](https://github.com/tkumata/discord-translate/issues/1)
- Issue タイトル: 補助サーバの自動起動をバージョン依存を解消する
- 作業ブランチ: `fix/issue-1`
- 確定要求: README の案内だけでは完了としない。
- 確定要求: 更新後も利用者の再登録なしで自動起動する。
- 採用: nvm 配下の対応 Node.js を起動時に解決する。
- 実装・自動検証・登録更新済み。実 Chrome はユーザ確認で合格。
- 2026-10-22、ユーザの動作確認報告を受けて完了した。

## Goal

利用者は、npm 更新後も補助サーバを自動起動できる。
利用者は、nvm 配下の Node.js 更新後も再登録せずに使える。
旧バージョンを削除した場合も、対応版が残っていれば起動する。
2026-10-22、ユーザは README の補足だけの案を不採用とした。
本計画は、自動起動を維持する承認済みの仕組みと検証を記録する。

## Scope

- `scripts/install-native-host.mjs` の両 launcher 生成。
- `scripts/tests/native-host.test.mjs` の launcher 経由の回帰試験。
- `README.md` と `docs/current/` の関連要求・仕様・設計。
- [ADR-013](../../adr/013-resolve-nvm-node-at-startup.md) の新設。
- 承認後、新 launcher へ移行するための一度の登録更新。

## Non-goals

- 拡張機能、両 Native host の処理、翻訳処理の変更。
- Node.js / npm / nvm の自動取得と alias の書換え。
- 監視プロセス、LaunchAgent、新しい依存関係の追加。
- 認証情報、許可 origin、登録先、ホスト名の変更。
- nvm 自体の移動・削除、リポジトリ移動の自動修復。
- Node.js の自動インストールと EOL のオンライン判定。
- 他のバージョン管理ツールへの対応追加。
- 過去の ADR と完了済み検証記録の書換え。

## Required Behavior

MUST は必須を表す。
確定要求と、承認済みの設計を分けて記載する。

### 確認した現状

- installer は登録時の `process.execPath` を launcher に保存する。
- 保存する Node.js のパスは絶対パスである。
- 両翻訳先の Native host は Node.js を使用する。
- 通常の自動起動経路では npm を実行しない。
- README は既に登録コマンドと再登録条件を記載している。
- 現在の端末では、両翻訳先の登録ファイルが存在する。
- 現在の launcher は nvm のバージョン別パスを参照している。
- 現在の nvm の `default` は `v24.22.1` に固定されている。
- 現在の動作基準は Node.js 24 LTS である。

### 原因候補と確認範囲

Node.js 更新後に旧版を削除すると、保存したパスが失効し得る。
パスが失効した場合、登録ファイルが残っていても起動できない。
npm 単体の更新が登録を削除した事実は確認していない。
利用者が報告した障害発生時の原因は断定しない。

### 確定要求

- MUST: README の記載だけで Issue の対応を完了しない。
- MUST: npm の配置とバージョンを通常起動の条件にしない。
- MUST: 対応版への更新後に旧 Node.js を削除しても起動する。
- MUST: 更新のたびに利用者へ再登録を求めない。
- MUST: 両翻訳先の自動起動を対象とする。
- MUST: 既存の起動待機、失敗通知、停止の動作を維持する。

### 承認済みの設計

- 登録時の Node.js の実体パスから nvm の管理ルートを確認する。
- nvm の場合、launcher は確認した管理ルートを保存する。
- 起動時は管理ルートの `versions/node/v*/bin/node` を列挙する。
- 各候補を実行し、バージョンと `process.release.lts` を確認する。
- 実行できない候補は stderr に診断を残し、選択対象から外す。
- 24 以上で LTS として公開された候補だけを選択対象とする。
- major、minor、patch を数値で比較し、最新版を選ぶ。
- 新しいメジャーでも、条件を満たす LTS は選択対象とする。
- `default` alias は参照しない。利用者の alias も変更しない。
- Chrome の PATH とシェル初期化ファイルに依存しない。
- nvm の人向け出力の解析や `nvm.sh` の読み込みを行わない。
- 解決処理は標準入力を読まず、Native 接続の入力を保持する。
- 候補の確認出力は捕捉し、stdout を Native framing 専用に保つ。
- Node.js の絶対パスと実行可否を確認して host を `exec` する。
- Chrome の引数と標準入出力を host へ引き継ぐ。
- 解決失敗時は stderr に理由を出して非ゼロで終了する。
- 解決失敗時に別の導入元や翻訳先へ切り替えない。
- nvm 管理外は既存の絶対パス方式を維持する。
- 管理外の Node.js も更新へ追従すると説明しない。
- 新方式への切替時だけ、既存 installer で一度再登録する。

サポート中の LTS の導入は、既存の利用環境の要件として維持する。
`process.release.lts` は現在のサポート期間を判定する値ではない。
起動時に EOL 情報を取得せず、導入済みの LTS から選択する。

## Tasks

### Task 1: nvm の対応版を起動時に解決する

- Result: 実装・自動検証済み。
- Objective: 対応 Node.js の更新・旧版削除後も自動起動する。
- Scope: installer の launcher 生成と既存の Native host テスト。
- Acceptance Criteria:
  - 登録時の旧版を削除しても、新しい対応版で起動する。
  - `default` が削除済みの旧版を指していても起動する。
  - 複数の対応版がある場合、最新版で起動する。
  - 新しいメジャーの LTS と非 LTS がある場合、LTS を選ぶ。
  - 最新 LTS の alias が未導入版を指していても起動する。
  - minor と patch の選択順が文字列順に左右されない。
  - npm が PATH にない場合も起動する。
  - 対応する実行可能な LTS がない場合、非ゼロで失敗する。
  - 起動失敗時に Native stdout へ診断を混ぜない。
  - 空白と引用符を含むパスで起動できる。
  - 引数、Native framing、入力拒否、EOF、signal の契約を保つ。
  - nvm 管理外の既存の登録動作を維持する。
- Verification:
  - 一時 HOME と nvm fixture で旧版削除と更新を再現する。
  - launcher を実行し、出力とプロセス終了を検証する。
  - 最小 PATH と未設定の NVM_DIR で検証する。
  - `node --test scripts/tests/native-host.test.mjs` を実行する。
  - `npm --prefix extension test` で既存機能を検証する。
  - 実環境の旧 Node.js や alias は削除・変更しない。

### Task 2: 動作契約と移行を揃える

- Result: 文書と登録の更新済み。実 Chrome はユーザ確認で合格。
- Objective: 実装に文書を合わせ、新 launcher へ移行する。
- Scope: README、関連する current 文書、ADR 一覧、Native 登録。
- Acceptance Criteria:
  - 対応する更新範囲と、初回の移行操作を明示する。
  - ADR-013 で旧絶対パス固定の判断を更新する。
  - 同じ拡張機能 ID で両 launcher を更新する。
  - manifest の許可 origin と launcher の実行権限を維持する。
  - 実 Chrome の未検証範囲を成功扱いしない。
- Verification:
  - Task 1 の合格を前提とする。
  - 文書リンク、`git diff --check`、最終差分を確認する。
  - 登録内容を確認し、既存の認証情報を変更しない。
  - 実 nvm で対応 Node.js の解決と launcher の起動を確認する。
  - 実 Chrome の起動・翻訳先切替・終了は利用者が確認する。

## Open Questions

未決定事項はない。
自動追従の保証対象は、現環境で確認した nvm の導入方式とする。
対応する Node.js 自体が存在しない場合は自動取得せずに失敗する。

## Validation

- `node --test scripts/tests/native-host.test.mjs`: 7 件成功。
- `npm --prefix extension test`: 112 件成功。
- `git diff --check` と追加文書リンク・README 内リンクの確認は成功した。
- fixture 内で登録時の実 Node.js を削除し、更新後の起動を確認した。
- 複数 LTS、非 LTS、古い alias、未導入 LTS alias を再現した。
- 版の数値順、最小 PATH、空白と引用符を含むパスを確認した。
- 候補の確認が Native 入力を読まないことを確認した。
- 引数と PID、Native framing、EOF、SIGTERM、入力拒否を確認した。
- 実 Node.js は v24.22.1。新メジャーは fixture の属性で再現した。
- 実環境の旧版と alias は変更していない。
- 既存の拡張 ID に対して、両 launcher を新方式へ更新した。
- 元の4登録ファイルは `/private/tmp/discord-native-backup-nbt9pvu1` に退避した。
- 2026-10-22、ユーザの削除指示により旧登録の退避4ファイルを削除した。
- 退避ディレクトリも削除した。現行の両登録は維持した。
- manifest 内容、許可 origin、launcher の 0700 を維持した。
- manifest の 0600 と、生成したシェルの構文を確認した。
- 実 nvm と最小 PATH で、両 launcher が host へ到達した。
- 起動確認には不正 caller を使い、サーバの新規起動は避けた。
- 既存の8766 listener (PID 87868) は同じプロセスのまま維持した。
- 2026-10-22、ユーザが「動作確認できました」と報告した。
- 今回の実 Chrome の受け入れはユーザ報告を根拠に合格とする。
- 個別操作と実環境の旧版削除による試験内訳は未報告である。
- エージェント自身による実 Chrome 操作は行っていない。
- 今回の更新は登録の退避削除と文書のみ。成功済みテストは再実行しない。

## References

- [Issue #1](https://github.com/tkumata/discord-translate/issues/1)
- [README](../../../README.md)
- [Native host installer](../../../scripts/install-native-host.mjs)
- [ADR-013: 起動時の Node.js 解決案](../../adr/013-resolve-nvm-node-at-startup.md)
- [ADR-010: Native Messaging](../../adr/010-native-messaging-startup.md)
- [ADR-012: 翻訳先別の起動](../../adr/012-provider-specific-server-startup.md)
- [既存の起動実装計画](2026-10-14-provider-server-startup.md)
- [nvm 公式 README](https://github.com/nvm-sh/nvm/blob/v0.40.3/README.md)
- [Node.js の LTS 属性](https://nodejs.org/docs/latest-v24.x/api/process.html#processrelease)
