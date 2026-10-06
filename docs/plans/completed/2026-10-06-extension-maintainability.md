# Chrome拡張の可読性と保守性の改善

## Status

- Phase: completed — 実装・自動検証完了、実Chrome受け入れはユーザ確認で合格
- Approval: approved — 2026-10-06「承認します。実装してください。」
- Created: 2026-10-06
- Implementation: Task 1〜3完了。ユーザの指定により今回の改善を完了とする。planはactiveに保持する。
- Baseline: `npm --prefix extension test`は70件成功。
- Baseline: `./.venv/bin/python scripts/verify.py --self-check`は成功。
- 実Chrome受け入れ: 2026-10-06、ユーザが実機で動作に問題ないことを確認した。
- 残る可読性の改善は今後の別作業とし、今回の範囲へ追加しない。

## Goal

受信翻訳、投稿前の英訳、通信、翻訳契約、ジョブ管理を個別に読める構成へ変更する。
機能の変更時に無関係な状態や起動処理を理解する必要を減らす。
ファイルを移すだけで終えず、重複した終了処理、密集した条件式、暗黙の状態所有を整理する。

## Current Problems

| 問題 | 現状の根拠 | 改善 |
| --- | --- | --- |
| 受信と投稿の異なる状態が同じスコープにある | `content-script.js`の621行に受信表示、検索、Slate編集、Port、bridge、設定が同居 | 機能内で状態を所有し、起動側は各機能のscanとdisposeだけを呼ぶ |
| workerへの変更が広い責務に影響する | `service-worker.js`の820行に翻訳契約、stream、queue、LRU、registry、Chrome入口が同居 | 既存の関数・classを実際の責務に沿って分離する |
| 検証条件が接続・表示の処理に埋まっている | `openTranslationRequest`の保存metadata検証、`lookupTranslation`の検索応答検証 | 翻訳応答と検索応答それぞれに具体的な検証関数名を付ける |
| 終了処理とrecord生成が散在する | queueの`expire`と`pump`の期限切れ処理、受信recordの生成・購読解除 | 各所有モジュール内で共通の小さな処理を使う |
| 内部名が処理の意味を隠す | HTTPを行わない`fetchTranslation`、受信専用の`records`、FIFO用の`hashQueue` | 実行、対象、受付順の意味が分かる名前へ変更する |
| テストが起動ファイルの内部へ依存する | content testがsourceへ非公開関数の公開コードを追記、契約testがworker入口をimport | Manifestの順序で読み込み、ChromeイベントとDOM操作で検証する |

## Scope

### worker側の配置

| ファイル | 責務 |
| --- | --- |
| `extension/translation-protocol.js`（新規） | エラー契約、sender/input、固定payload、最終応答とstreamの検証・累積。Chrome listenerや起動状態を持たない |
| `extension/translation-queue.js`（新規） | 受付順、hash処理、FIFO、共有job、購読、LRU、実行期限と翻訳要求の監督 |
| `extension/bridge-registry.js`（新規） | tab別bridge Portの登録、接続待機、要求と応答の対応、切断とtransportの解放 |
| `extension/service-worker.js` | Chrome入口、要求Port、受信保存・検索の配線と同期listener登録 |

protocolからqueue、registry、Chrome入口をimportしない。
Web Crypto呼出しと翻訳要求の実行・timer・診断出力はprotocolから分離する。
registryはtransportの状態、queueは共有jobの状態を所有する。
旧入口からの不要な再exportや互換経路は残さず、呼出し元とtestのimportを更新する。

### content側の配置

| ファイル | 責務 |
| --- | --- |
| `extension/request-client.js`（新規） | 要求Port、固定応答の検証、通信期限、切断・解放 |
| `extension/received-messages.js`（新規） | 受信message検出、受信record、保存訳検索、翻訳表示、手動再試行、古い結果の破棄 |
| `extension/draft-composer.js`（新規） | 投稿入力欄の検出、編集世代、英訳、更新確認、翻訳前の下書きへの復元 |
| `extension/content-script.js` | top frameの起動、設定、observer、bridge iframe、各機能の開始・scan・終了 |

Manifestの`content_scripts.js`配列でこの順序のclassic scriptを読み込む。
Chrome標準のISOLATED環境を維持し、各機能のMapと状態はclosure内で所有する。
起動時に必要な依存を渡し、機能同士のMapを直接操作しない。
通信側は応答形式と通信終了を判断し、表示対象の有効性は機能側が判断する。
受信と投稿を共通のrecordや状態機械へ統合しない。

### 関連ファイル

- `extension/manifest.json`はcontent scriptの読み込み配列だけを変更する。
- `extension/tests/`は責務別のtestと共通fixtureへ整理し、importと起動方法を更新する。
- `docs/current/DESIGN.md`の責務表・依存方向・投稿処理の配置を同期する。
- `README.md`の開発向けファイル案内と本計画の結果を更新する。
- `bridge.js`、`popup.js`、`received-translation-cache.js`は既に実行境界が分かれているため、今回の分割対象にしない。

## Non-goals

- 翻訳機能、画面表示、生成設定、翻訳promptの変更。
- popupの動作変更、サーバやモデルの変更。
- 新依存、bundler、TypeScript、build工程、権限の追加。
- 公開resource、MAIN world、page message、HTTP経路の追加。
- 汎用UI framework、共通state framework、plugin機構、将来用interface。
- test件数削減を目的とする削除、期待値の弱体化。
- 過去のcompleted planの書き直し。

## Required Behavior

- 手動押下でのみ翻訳し、自動投稿しない。保存訳の検索では翻訳POSTを行わない。
- bridgeだけが翻訳HTTPを実行し、workerがqueueと翻訳の成功判定を所有する。
- sender、frame、URL、tab、入力・応答schemaの厳密な検証を維持する。
- FIFO、同時実行1、unique job上限64、待機と実行の120秒期限を維持する。
- 翻訳先込みSHA-256、同一jobの共有、256件・30分の成功LRUを維持する。
- 最初の依頼tabへの配送と、購読解除で共有jobをcancelしない契約を維持する。
- 正常finish、usage、SSE終端が揃うまで完成訳を確定・cache保存しない。
- thinking、tool、不正UTF-8、異常終了と長さ制限の検証を維持する。
- 原文、訳文、payload、例外詳細を診断に出さない。
- 受信のID・本文・DOM・record、投稿の経路・入力欄・編集世代を使う失効条件を維持する。
- OFF、切断、DOM交換で購読・timer・UIを解放する。
- 下書きは完成英訳だけを適用し、編集状態への反映確認と復元対象の管理を維持する。
- 受信完成訳だけの5日保存、期限非延長、保存失敗時の表示保持を維持する。
- Chrome listenerを起動時に同期登録する。

## Tasks

### Task 1: workerの責務を分離する

- Status: completed — 実装・自動検証完了。実Chrome受け入れはユーザ確認で合格。
- 既存のprotocol、queue、registryを上記配置へ移す。
- queueの期限切れ処理を一元化し、FIFO用hash受付の意図を明記する。
- 誤解を招く内部名を変更し、不要な入口への依存を除く。
- 契約、queue、registryのtestを各責務へ移し、worker配線の結合testを残す。
- Acceptance: protocol単体の利用がChrome入口の起動やsingleton生成を必要としない。
- Acceptance: 既存の順序、期限、購読、cache、Port、保存の動作検証が成功する。

### Task 2: contentの機能と状態を分離する

- Status: completed — 実装・自動検証完了。実Chrome受け入れはユーザ確認で合格。
- Port client、受信、投稿、起動を上記配置へ移す。
- 受信recordの生成・破棄、投稿UIの取り付けを機能内の小さな関数へまとめる。
- 保存metadataと検索応答の条件に具体的な名前を付け、表示状態の変更から分離する。
- Manifest順にscriptを評価するfixtureへ変更し、非公開関数を公開するsource追記を除く。
- ON/OFFはStorage通知、scanはobserver callback、翻訳は実際のbutton操作で検証する。
- 共通DOM/Chrome fixtureを分離し、受信と投稿の動作testを分ける。
- Acceptance: 個々の機能が他機能の状態を読まず、起動側が内部Mapを操作しない。
- Acceptance: 途中表示、再試行、復元、IME、編集・移動・OFF時の古い応答破棄が維持される。

### Task 3: 最終確認と設計の同期

- Status: completed — 実装・自動検証完了。実Chrome受け入れはユーザ確認で合格。
- 全呼出し元を確認し、旧関数名、旧import、二重起動、不要な互換経路の残存を確認する。
- 同じ動作を守るtestは保持し、機能間の結合testも実際の配線を通す。
- README、DESIGNと本計画へ最終配置と確認結果を記録する。
- Acceptance: ソースと設計の責務・依存関係が一致する。
- Acceptance: 自動確認と実Chromeの未確認範囲を区別して報告する。

## Verification

- 各実装Taskで変更された動作に対応するtestを実行する。
- 最終差分で`npm --prefix extension test`を実行する。
- 変更・追加JavaScriptに`node --check`を実行する。
- ManifestをJSONとして解析し、test fixtureが実際のscript配列を使用することを確認する。
- `git diff --check`と最終差分の責務・依存・承認範囲を確認する。
- サーバ検証scriptは変更しないため、成功済みself-checkを理由なく繰り返さない。
- 実Chromeでは拡張再読込み、受信の途中表示と再試行、保存訳復元、下書き英訳と復元、OFFを確認する。
- Nodeの模擬DOM合格だけで、Discord実DOM・Slate・Chromeのscript読み込みの受け入れを成功扱いしない。

## Results

- `content-script.js`は621行から101行、`service-worker.js`は820行から129行へ整理した。
- 処理を削除するための行数削減ではなく、既存の責務を独立したファイルへ移した。
- protocol、queue、registry、Port client、受信、投稿の配置はScopeのとおり。
- 受信recordの生成・破棄とqueueの期限切れ処理を一元化した。
- Port応答、保存metadata、検索hit/missの検証に具体的な名前を付けた。
- 受信・投稿のMapと有効状態を各closureへ閉じ込め、重複するactiveRequests管理を除いた。
- 訳文ラベルと本文はDOMの子順序ではなく参照で保持し、本文が取り除かれた場合は表示を再構成する。
- 旧関数名`fetchTranslation`は`runTranslationRequest`へ変更し、入口の互換再exportは追加していない。
- content testはManifestの実配列でscriptを読み、設定通知・observer通知・button操作から検証する。
- 初回全体実行は既存の既定bridge testの非同期待機が停止したため中断した。
- 非同期hashの完了をイベントループ1回で決め打ちしていた待機を、要求到達の条件待機へ修正した。
- 修正後の`npm --prefix extension test`は72件成功、失敗・cancel・skipは0件。
- 既存70件のtestをすべて保持し、期限timer通知前の失効と翻訳本文消失の回帰を2件追加した。
- 全JavaScriptの構文チェック、Manifest解析と全scriptの存在確認は成功。
- Manifestの既存権限、公開resource、ISOLATED環境は維持されている。
- tracked/untrackedの全差分について空白・末尾改行の検証は成功。
- server、model、prompt、生成設定、popup、CSS、保存moduleは変更していない。
- 2026-10-06、ユーザは今回の変更を実機確認し、動作に問題ないと報告した。今回の実Chrome受け入れはこの報告を根拠に合格とする。
- エージェントによる実Chrome操作は未実施。個別の操作状態・異常系の実機試験内訳は未報告。
- ユーザは可読性の改善を確認し、残る記述の整理は今後に延期した。今回の承認範囲は完了とする。

## References

- [現在の設計](../../current/DESIGN.md)
- [外部仕様](../../current/SPECIFICATIONS.md)
- [ADR-003: queue所有](../../adr/003-service-worker-owns-queue.md)
- [ADR-005: HTTP境界](../../adr/005-extension-document-translation-bridge.md)
- [ADR-007: 順次表示](../../adr/007-streaming-translation.md)
- [ADR-008: 受信訳保存](../../adr/008-persist-received-translations.md)
- [Chrome公式: scriptの読み込み順と実行環境](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
