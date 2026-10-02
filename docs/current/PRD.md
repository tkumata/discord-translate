# PRD: Discord ローカル日本語翻訳

- Status: Current product definition
- Last reviewed: 2026-10-02
- 2026-10-02: 順次表示を承認・実装済み。自動検証と実モデル検証は成功、実ChromeもユーザーのTask 5実機確認により合格・本変更完了。第11節を参照する。
- Product maturity: Streaming manual translation implemented and tested; Task 5 Chrome acceptance confirmed by user

## 1. 背景

Discord Webの外国語メッセージを読むたびに外部翻訳サービスへコピーすると、会話が分断され、本文が外部へ送信される。Apple Silicon Mac上のMLXを使えば、個人のMac内で短文翻訳を処理できる。

## 2. 対象ユーザー

- Apple Silicon MacでChrome版Discordを使う単一ユーザー
- 英語を中心とする外国語のDiscord会話を日本語で素早く読みたいユーザー
- Discord本文を外部LLM・翻訳APIへ送信したくないユーザー

多人数サーバ運用者、LAN共有API利用者、汎用LLM serving利用者は対象にしない。

## 3. 課題

1. 外国語メッセージの読解に手作業のcopy/pasteが必要である。
2. 外部翻訳APIはDiscord本文をMac外へ送る。
3. ローカルLLMを直接操作するだけではDiscord上の原文と訳文を対応付けられない。
4. 閲覧しただけのメッセージを一律送信すると、不要な翻訳要求と待ち時間が発生する。

Chrome Extensionのpopup health、service workerのqueue/cache/API検証、Discord tab内のExtension document bridge、各メッセージの`翻訳`ボタン押下時だけ依頼するcontent scriptは実装・Node自動検証済みである。順次表示の実Chrome受け入れは2026-10-02のユーザーによるTask 5実機確認で合格した。LAN拒否、長時間安定性、launchd等の別範囲の確認状態は変更しない。

## 4. 製品ゴール

- Discord Web上で対象メッセージに対応する自然な日本語訳を得られる。
- 翻訳処理と本文の通信を1台のMac内に閉じる。
- 原文、Markdown、URL、コード、Discord識別子、絵文字を壊さない。
- 短いDiscordメッセージを、Chromeと共存できるメモリ範囲で安定して処理する。
- 導入、起動、停止、障害復旧、検証を利用者が文書だけで実行できる。

## 5. 非ゴール

- production向け汎用LLM serving platform
- LAN・インターネット公開、認証、多ユーザー管理
- 外部LLM API・翻訳API・telemetry・analytics
- 複数model同時常駐、製品固有のserver-side訳文cache
- 最初からの独自API serverやWeb framework導入
- Discordへの投稿内容の保存・分析

## 6. 製品スコープ

### 6.1 必須スコープ

- Chrome content scriptによるDiscordメッセージごとの`翻訳`ボタンと訳文UI
- service workerによるsender/input、FIFO queue、有限timeout監督、固定payload、response最終検証と、検証済みExtension document bridgeによるlocalhost HTTP送信
- Extensionの既定OFF toggle、現在・新規messageへの翻訳ボタン、押下時だけの翻訳要求、原文直下の訳文、再試行可能error
- popupのhealth確認によるLNA許可取得と、成功時だけの有効化
- concurrency 1の有限queueとmemory限定cache
- `mlx_lm.server`とQwen MLX 4bitによるlocal translation
- loopback、Extension origin限定CORS、offline通常運用、本文非保存
- 固定翻訳ケース、Chrome実UI、LAN拒否、連続実行、memoryの検証
- 基本機能完了後のlaunchd自動起動
- セットアップ、使い方、権限、privacy、障害対応の利用者文書

### 6.2 現在利用可能な範囲

- Python仮想環境と固定依存
- Qwen3-8B-4bitのcache
- loopback/offline `mlx_lm.server` 起動script
- OpenAI風chat completion API
- server契約を確認する検証script
- Manifest V3 Chrome Extension（静的実装・Node 自動検証・headless unpacked load 済み）

実Extension IDのCORS preflight、popup health、手動翻訳UI 8件を含むNode test 32件は確認済みである。実Chromeの順次表示は2026-10-02のユーザーによるTask 5実機確認で合格した。launchdは未実装である。

## 7. ユーザーストーリー

| ID     | ストーリー                                                                                                                    | 完了状態                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| US-001 | 利用者として、読みたい Discord メッセージだけをボタンで選び、その場で日本語訳を読みたい。                                     | 実装済み・Node test合格、Task 5実Chrome確認合格（ユーザー報告）                                                     |
| US-002 | 利用者として、原文を残したまま翻訳失敗の境界を固定 code で把握し、後で再試行したい。                                          | 再試行 UI と SHA-256/LNA/network の固定code 分離は実装済み・Node test 合格。実Chrome表示はTask 5で合格（ユーザー報告） |
| US-003 | 利用者として、本文が外部サービスへ送られない状態で使いたい。                                                                  | サーバ単体のみ確認、E2E未完了                                                                      |
| US-004 | 利用者として、1コマンドでserverを起動し、明示的に停止したい。                                                                 | foreground起動・停止は完了                                                                         |
| US-005 | 利用者として、Chromeに必要最小権限だけを許可したい。                                                                          | manifest/headless load/実ID preflight/実Chrome health確認済み                                      |
| US-009 | 利用者として、Chromeのsecurityを無効化せず、Discord originへCORSや任意Extension resourceを公開せずにlocalhost翻訳を使いたい。 | bridge実装・Node test済み、Task 5実Chrome確認合格（ユーザー報告）                                                      |
| US-008 | 利用者として、翻訳をONにするときに接続可否を確認し、LNA拒否やサーバ停止時はOFFのまま原因codeを把握したい。                    | 実装済み・Node test合格・実Chrome health成功                                                       |
| US-006 | 利用者として、ログイン後に安全な設定で自動起動したい。                                                                        | 未完了                                                                                             |
| US-007 | 保守者として、modelをコード変更なしで入れ替えて同じ試験で比較したい。                                                         | model切替は可能、比較未実施                                                                        |

## 8. 成功指標

### 8.1 製品受け入れ指標

- Chrome実UIでDiscordメッセージと訳文が混線せず対応する。
- ON中の現在表示中・新規メッセージに各1個の`翻訳`ボタンがあり、DOM検出だけでは翻訳POSTが発生しない。
- 翻訳POSTは`翻訳`または`再試行`の押下時だけ発生し、連打で重複要求を作らない。
- 固定翻訳ケースで日本語のみを返し、指定不変要素を保持する。
- 実Extension originだけがCORS許可され、権限がlocalhost以外へ広がらない。
- popup health成功時だけONになり、LNA拒否時はOFFを維持して本文なし固定codeを表示する。
- 通常運用中にDiscord本文を含む外部通信・永続ログがない。
- 100件短文後に順序混線、hang、無制限なRSS増加がない。
- server停止時に原文を保持した有限時間のエラーとなり、再起動後に復旧する。
- SHA-256失敗、Chrome local network拒否、timeout、その他network失敗を本文なし固定codeで識別できる。
- 正規Discord tabの非表示bridgeだけが固定localhost POSTを行い、別tab・別origin・page message・任意URLでは送信しない。
- launchd導入後もloopback/offline/privacy条件が変わらない。

### 8.2 現在のbaseline

- server baseline: 26リクエスト成功（後続の実ID検証はMarkdown/URL条件未合格）
- 平均latency: 1.843秒
- 20件直列最大latency: 2.113秒
- 測定RSS: 4,831,392 KB
- 単体generate: prompt 11.294 tok/s、generation 17.776 tok/s、peak 4.707 GB
- 実ID `chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf`: `/health`、CORS preflight、headless unpacked load、実Chrome popup health成功、sender URL検証hotfixとPhase 5.3 error分類のNode test合格。hotfix後の実Chromeは`network_error`でbrowser由来POST未到達

baselineは合否閾値ではない。ChromeとDiscordを同時利用した許容latency・RSS上限は、結合試験後に利用者判断で確定する。

## 9. リリース条件

[要件定義書の受け入れ条件](REQUIREMENTS.md#5-受け入れ条件と追跡) AC-001〜AC-016が合格し、未実装または未検証項目を残さないこと。構造検証、server実推論、Chrome UI、network privacy、LAN拒否、memory安定性、benchmark、launchdを別々の証拠として確認する。

## 10. 未決定・未検証事項

以下のChrome関連記述は変更前の確認記録である。順次表示のTask 5実機確認は第11節のとおりユーザー報告により合格した。

- 候補selector `li[id^="chat-messages-"]` と `[id^="message-content-"]` の認証済みDiscord実UI適合
- Phase 5.4 bridgeのDiscord CSP下load、Port sender field、browser由来POST、OFF/unload/disconnectとcontent経由E2E
- Markdown/URLの`**the patch**`不変条件の再確認
- Chrome/Discord共存時のlatencyとRSS合否値
- launchdのrestart policyとbounded log方式

headless unpacked load、実ID preflight、実Chrome health、sender URL hotfix、Phase 5.3 error分類、実Chromeの`network_error`とPOST未到達は確認済みである。Phase 5.4 bridgeとPhase 5.5手動翻訳UIは実装・Node test済みだが、実Chromeのbridge、button起点POST、DOM表示、Markdown/URL条件は未検証である。

## 11. 訳文の順次表示（2026-10-02）

- 状態: 2026-10-02承認・実装済み。Node自動検証と実モデル結合確認済み、実ChromeもユーザーのTask 5実機確認により合格し、本変更は完了。別範囲の受け入れ状態は変更しない。
- 背景: 利用者は現行の翻訳動作を意図どおりと確認しているが、日本語訳が完成するまで待つ時間を短く感じられるようにしたい。
- ゴール: 現在の `mlx-community/Qwen3-8B-4bit` を維持し、生成された訳文から原文直下で読み始められるようにする。
- 対象: 手動で選んだメッセージの streaming 表示、途中失敗時の再試行、既存入力 KV cache の再利用確認。
- 成功指標: cache miss の複数 chunk 応答で、完了前に部分訳が表示され、その後も同じ訳文ブロックが更新される。正常終了時だけ確定し、失敗・本文変更・OFF 後の部分訳は残さない。
- 変更しない範囲: モデル、翻訳品質条件、queue の並行数1、timeout、権限、外部通信・本文永続化禁止。生成完了時間の短縮率は約束しない。

第5節の初期streaming除外は承認済み順次表示仕様へ置き換えた。「server-side cache」の除外は製品固有の訳文 cache を意味し、公式 MLX-LM が既に持つメモリ内入力 KV cache とは区別する。2026-10-02 に異なる固定非機密英文間で 66 token の再利用を確認したため、cache 有効化の追加変更は不要である。

関連: [追加要求](REQUIREMENTS.md#7-訳文の順次表示の追加要求2026-10-02)、[実装計画](../plans/active/2026-10-02-streaming-translation.md)。
