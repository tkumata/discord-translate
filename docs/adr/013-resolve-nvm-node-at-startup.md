# ADR-013 nvm の Node.js を Native host 起動時に解決する

## Status

Accepted — 2026-10-22、ユーザが計画と設計案を承認した。
実装・Node test 112 件・既存登録の移行確認済み。
2026-10-22、ユーザの動作確認報告により実 Chrome の受け入れは合格。
個別操作と実環境の旧版削除による試験内訳は未報告である。
ADR-010 の Node.js 実体パス固定を対応範囲内で更新する。
ADR-012 の Node.js 更新後の再登録条件も、対応範囲内で更新する。

## Context

両 Native host の launcher は `process.execPath` を固定している。
nvm の旧 Node.js を削除すると、保存した実体パスが失効する。
現在の nvm の `default` も旧版の固定値である。
`default` だけを参照する変更では、旧版削除に対応できない。
ユーザは README の案内だけの対応を不採用とした。
ユーザは更新後も再登録なしで自動起動する仕組みを求めている。

## Decision

以下を採用する。

- 登録時に nvm 管理下かを実体パスと管理ルートから確認する。
- nvm 管理下では、個別の Node.js ではなく管理ルートを保存する。
- 起動時に `versions/node/v*/bin/node` だけを列挙する。
- 各実行ファイルのバージョンと `process.release.lts` を確認する。
- 実行に失敗した候補は診断を残し、選択対象から外す。
- 24 以上で LTS として公開された候補を選択対象とする。
- major、minor、patch の数値順で最新版を選ぶ。
- 新メジャーの LTS への更新も、同じ選択条件で追従する。
- `default`、Chrome の PATH、シェル初期化ファイルを使わない。
- 解決処理の stdin は `/dev/null` とし、Native 入力を読まない。
- 候補の確認出力を捕捉し、stdout を Native framing 専用に保つ。
- パスと実行可否を確認後、Node.js と固定 host を `exec` する。
- host には Chrome の引数と標準入出力を引き継ぐ。
- 解決失敗は stderr と非ゼロ終了で通知する。
- 起動時の取得、alias 更新、他の導入元への探索は行わない。
- nvm 管理外では、既存の実体パス固定を維持する。
- 新 launcher へ移行するため、一度だけ登録を更新する。

サポート中 LTS の導入要件は維持する。
LTS 属性は EOL 後も残るため、サポート終了日の判定には使わない。
起動時にサポート情報を取得する仕組みは追加しない。

## Alternatives

### nvm の default alias を使う

- 利点: 利用者の既定バージョンを使える。
- 欠点: 旧版に固定した alias が残ると起動できない。

### nvm which 24 で解決する

- 利点: 既存コマンドだけで同じ系列の更新に追従できる。
- 欠点: 新メジャーへの更新後に 24 系を消すと起動できない。

### nvm ls の表示を解析する

- 利点: nvm の公開コマンドを使える。
- 欠点: 機械処理専用の形式がなく、表示形式への依存が増える。

### LTS を区別せず最新版を選ぶ

- 利点: 新しいメジャーへの更新にも追従できる。
- 欠点: 対応確認前のバージョンまで実行対象になる。

### 専用の Node.js を複製する

- 利点: nvm の更新や旧版削除の影響を受けない。
- 欠点: Node.js の更新と配布を別に管理する必要がある。

## Rationale

現環境で確認した nvm の管理ルート内だけを探索する。
公開コマンドの装飾付き表示や、古い alias に依存しない。
実行ファイル自身の属性で LTS を判定する。
Node.js 24 に固定せず、LTS のメジャー更新にも追従する。
最後の `exec` により、既存の signal と EOF の契約を維持する。

## Consequences

### Positive

- npm の更新で再登録を求めない。
- nvm の Node.js 更新後に旧版を削除しても起動できる。
- 新しい依存関係と常駐プロセスを追加しない。

### Negative

- 対応する実行可能な LTS が一つもない場合は起動できない。
- nvm 自体の移動・削除と管理方式の変更には追従しない。
- nvm の管理ディレクトリ構造に依存する。
- バージョンの数値比較と候補選択の回帰テストが必要になる。
- EOL 後も LTS 属性が残るため、EOL の自動判定は行わない。

## References

- [Issue #1](https://github.com/tkumata/discord-translate/issues/1)
- [実装計画](../plans/active/2026-10-22-native-host-node-resolution.md)
- [ADR-010](010-native-messaging-startup.md)
- [ADR-012](012-provider-specific-server-startup.md)
- [nvm 公式 README](https://github.com/nvm-sh/nvm/blob/v0.40.3/README.md)
- [nvm 公式実装](https://github.com/nvm-sh/nvm/blob/v0.40.3/nvm.sh)
- [Node.js の LTS 属性](https://nodejs.org/docs/latest-v24.x/api/process.html#processrelease)
