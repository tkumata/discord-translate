# 原文と訳文の境界を明示する表示改善

## 状態と承認

- 日付: 2026-08-27
- 状態: 実装・自動検証完了。実Chromeでの目視確認は未実施。
- 承認: 見出し・左線・薄い背景を使う提案に対し、ユーザが「OK 進めてください。ドキュメント化も忘れないように。」と承認。

## 変更範囲

- `extension/content-script.js`: 既存の訳文ブロック内に可視の`日本語訳`ラベルと訳文本体を分けて配置する。`textContent`で安全に設定し、原文直後の配置、`lang="ja"`、拡張固有属性を維持する。
- `extension/styles.css`: 小さな太字のラベル、8pxの上余白、細い左線、薄い背景、内側余白を追加する。訳文は通常本文色と改行を維持し、Discordのテーマ変数を使う。
- `extension/tests/content-script.test.js`: 既存成功ケースでラベル・訳文本体・原文保持を検証し、表示構造に依存する既存の期待値を更新する。
- `docs/current/SPECIFICATIONS.md`と`docs/current/DESIGN.md`: 表示仕様とDOM構造を反映する。

原文、翻訳ボタン、loading、error、通信、状態遷移、依存関係は変更しない。

## 検証

- 既存ハーネス: `cd extension && npm test` — 38件成功。
- 構文と差分: `node --check extension/content-script.js`、`git diff --check` — 成功。
- 成功ケースでラベルと本文の分離、HTML風文字列と改行の保持、原文保持、原文直後への配置、`lang="ja"`を検証した。
- 実Chromeの明暗テーマ・長文表示は未確認。拡張機能とDiscordタブを再読み込みし、翻訳後の見出し・背景・左線・折り返しを目視確認する。
