# 「翻訳」ボタン視認性改善 実装計画

## Status

- State: Approval pending
- Date: 2026-08-18
- Approval: 本文書の承認後に実装する。承認前は本番コード、テスト、設定を変更しない。

## 目的

Discordメッセージに表示する`翻訳`操作を、リンク風の文字ではなくボタンとして一目で判別できる外観にする。

## 現状

`extension/styles.css`の`.discord-translate-button`は、背景が透明、枠線が0、左右paddingが0であり、クリック可能なボタンとして判別しにくい。押下後は同じ要素が`.discord-translate-loading`へ変わり、`disabled`かつ`翻訳中…`表示になる。

## 対象範囲

- 変更対象は`extension/styles.css`のみとする。
- `.discord-translate-button`と`.discord-translate-loading`へ背景、1pxの枠線、角丸、水平paddingを付け、通常時と処理中のどちらでもボタン形状を維持する。
- `.discord-translate-button:hover`で背景色と枠線色を変え、ポインタ操作への反応を示す。
- `.discord-translate-button:focus-visible`へ明瞭なoutlineとoffsetを付け、キーボード操作時のfocusを判別可能にする。
- `.discord-translate-loading`は`翻訳中…`、`cursor: wait`、disabled相当の控えめな色またはopacityで、通常状態と区別する。
- 色は既存のDiscord CSS変数とfallbackを使い、light/dark両表示で文字と輪郭の判別性を保つ。

## 対象外

- `extension/content-script.js`を含む動作、DOM生成、文言、状態遷移の変更
- API、service worker、bridge、popup、manifest、権限、依存関係の変更
- 新しい画像、アイコン、ライブラリの追加
- 再試行ボタンや他のDiscord UIの再設計

## 実装手順

1. 既存の`.discord-translate-button, .discord-translate-loading`共通規則を、ボタン形状が分かる最小の背景・枠線・角丸・paddingへ更新する。
2. 通常ボタンだけに`:hover`と`:focus-visible`を追加する。
3. `.discord-translate-loading`の待機中表示を維持し、通常ボタンとの差を色またはopacityで補う。

## 完了条件と検証

- 通常、hover、focus-visible、loadingの各状態をCSS上で判別できる。
- 通常時とloading時の双方に、背景、1px枠線、角丸、水平paddingが適用される。
- `cd extension && npm test`が成功し、既存の翻訳動作契約に回帰がない。
- 対象CSSの差分を確認し、変更が`extension/styles.css`だけである。
- `git diff --check`が成功する。
- 実Chromeでの目視確認が可能な場合は、通常・hover・キーボードfocus・`翻訳中…`をDiscordのlight/dark表示で確認する。未実施の場合は完了報告で明示する。

