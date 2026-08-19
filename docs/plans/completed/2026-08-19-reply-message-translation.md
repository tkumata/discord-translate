# 返信付きメッセージの翻訳修正 実装計画

## Status

- State: Completed
- Date: 2026-08-19
- Approval: 承認済みの範囲で実装と自動検証を完了した。実Discord UI確認は未実施。

## Objective

返信プレビューを含むDiscordメッセージでも、現在メッセージの本文だけに`翻訳`ボタンを表示し、その本文だけを翻訳要求へ渡す。

## Current state

`extension/content-script.js`の`findMessageContent`は、メッセージコンテナ内にある`message-content-*`候補をDOM順に調べ、同じコンテナを最寄りの`chat-messages-*`祖先に持つ最初の候補を返す。返信プレビューが現在メッセージの本文より先にあり、同じコンテナ内に含まれる場合、返信先の本文を現在メッセージの本文として選び得る。

その結果、現在本文に`翻訳`ボタンが付かない、または現在コンテナのmessage IDと返信プレビューの本文を組み合わせた要求が送られ、`invalid_response`として失敗する経路がある。既存テストには、返信プレビューと現在本文が同じコンテナに共存するDOM順の回帰ケースがない。

## Scope

- `findMessageContent`が、現在の`chat-messages-<channel-id>-<message-id>`コンテナからmessage IDを取得し、同じIDを持つ`message-content-<message-id>`だけを返すようにする。
- 一致する現在本文がない場合は、返信プレビューへfallbackせず`null`を返す既存の安全側動作を維持する。
- 返信プレビューを現在本文より先に配置した回帰テストを追加し、ボタン位置と翻訳要求の`messageId`、`text`が現在メッセージに対応することを検証する。
- 既存の通常メッセージ、重複ボタン抑止、pending、成功、失敗、再試行、本文変更、content node差し替えの動作を維持する。

## Out of scope

- `extension/service-worker.js`、bridge、翻訳API、server、response schemaの変更
- popup、manifest、CSS、権限、依存関係の変更
- Discord返信プレビュー自体の翻訳、返信先メッセージの取得、threadや引用UIの新機能
- message ID形式の緩和、生成class名や追加selectorへの対応
- 現在文書、README、ADRの更新（外部仕様または長期設計判断は変わらない）

## Approach

1. `findMessageContent`でコンテナIDから現在message IDを一度だけ特定する。
2. コンテナ直下の候補探索は維持しつつ、厳密に一致する`message-content-<message-id>`だけを採用する。返信プレビューを選ぶfallbackは追加しない。
3. `extension/tests/content-script.test.js`の既存fake DOMと`node:test`を再利用し、返信プレビューが先、現在本文が後の1ケースを追加する。新しいtest frameworkや汎用DOM abstractionは追加しない。

## Affected files

- `extension/content-script.js`
- `extension/tests/content-script.test.js`

## Phase

### Phase 1: 本文選択修正と回帰検証

- 目的: 返信付きメッセージで現在本文だけを翻訳対象にする。
- 前提: 本計画の対象範囲について利用者の承認を得ること。
- 対象: `findMessageContent`のID一致条件と、返信プレビュー先行DOMの回帰テスト。
- 対象外: service worker、API、response検証、Discord DOM selector全般の再設計。
- 完了条件: 返信付きケースで現在本文の直後にボタンが1つ表示され、押下時に現在コンテナIDと現在本文だけが送信される。既存テストも成功する。
- 検証方法: `cd extension && npm test`、`node --check content-script.js`、対象差分確認、`git diff --check`。可能なら実Discord Webで返信付きメッセージのボタン位置と翻訳成功を目視確認し、未実施なら完了報告で明示する。
- 文書更新: 実装と検証完了後、本書の`Status`、`Progress`、`Outcome`を更新し、既存規約に従ってcompletedへ移動する。
- 未解決事項: Discord実UIのDOMが想定したID対応と異なる場合は実装を完了扱いにせず、観測したDOMに基づいて再計画する。
- 次フェーズへの引き継ぎ: なし。対象の自動検証と可能な実UI確認が終われば完了とする。

## Success criteria

- 返信プレビューが現在本文より先にあっても、`翻訳`ボタンは現在本文の直後に1つだけ表示される。
- ボタン押下時の要求は、`messageId`が現在の`chat-messages-*`コンテナID、`text`が現在本文である。
- 返信プレビュー本文は翻訳要求へ送られない。
- 一致する現在本文がないコンテナにはボタンを表示しない。
- `cd extension && npm test`、`node --check content-script.js`、`git diff --check`が成功する。

## Risks

- Discordの実DOMでコンテナIDと本文IDの対応が異なる場合、厳密一致によりボタンを表示しない。誤った返信プレビューを送るより安全側とし、実DOMを確認してから追加対応を別途計画する。
- fake DOMテストだけではDiscord側DOM変更を証明できないため、実UI確認の実施有無を完了報告で分離する。

## Progress

- 完了: `findMessageContent`を現在コンテナのmessage IDと一致する本文だけを選ぶ実装へ変更し、返信プレビュー先行ケースの回帰テストを追加した。
- 完了: content script 9/9、service worker単独17/17、全体36/36のテストに成功した。全JavaScriptの構文、manifest JSON、`git diff --check`も成功した。
- 次: 必須の実装・自動検証はなし。実Discord Webでの確認を行う場合は、返信付きメッセージのボタン位置と翻訳成功を確認する。
- 変更済みファイル: `extension/content-script.js`、`extension/tests/content-script.test.js`、本計画文書。
- 未解決事項: 実Discord UI確認は未実施。

## Decisions

- 本文はDOM順や表示文字列ではなく、現在コンテナのmessage IDとの一致で選ぶ。
- ID不一致時のfallbackは設けない。
- 修正はcontent scriptとその既存標準テストだけに限定する。

## Outcome

現在message IDとの厳密一致により返信プレビューを翻訳対象から除外し、返信プレビューが先にあるDOMの回帰テストを追加した。content script 9/9、service worker単独17/17、全体36/36のテスト、全JavaScript構文、manifest JSON、`git diff --check`は成功した。

全体テストの初回実行だけは既存bridgeテストが120秒で失敗したが、同テストの単独再実行と全体再実行はいずれも成功した。実Discord UIでの目視確認は未実施のため、実DOM上の動作は未確認として残す。既存のplans直下の構成に従い、本書は移動しない。
