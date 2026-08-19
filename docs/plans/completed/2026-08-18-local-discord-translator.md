# ローカル Discord 日本語翻訳 実行計画

## Status

- State: Completed; manual per-message translation and Phase 5.6 bridge/timeout correction implemented and verified
- Date: 2026-08-18
- Approval: Phase 1〜5.6は承認・実装・検証済み。利用者が全検証結果を確認し、本作業の完了を承認した。launchd、新規依存、独自wrapperは本作業の対象外。

## Objective

Apple Silicon Mac 1台でDiscord本文を外部へ送らず、Chrome上のDiscord WebメッセージをQwen/MLXで日本語へ翻訳し、原文と対応する訳文を安全に表示できる製品を完成させる。

## Current state

### 実装済み

- `.venv`と`mlx-lm==0.31.3`の依存環境
- `mlx-community/Qwen3-8B-4bit`のdownloadとlocal cache
- `scripts/start-server.sh`によるloopback、offline、Extension origin限定CORS、thinking無効、server concurrency 1の起動
- `scripts/verify.py`によるhealth、CORS、response schema、固定6翻訳ケース、20件直列検証
- server単体の導入・起動・API・検証README
- Manifest V3 Extension、content script、service worker queue/cache、popup、Node標準test
- popup documentの固定health GETによるLNA bootstrap、health/stateの固定error code、content script失敗UIの固定error code表示
- Phase 5.4のhidden bridge iframe、検証済みPort、固定localhost POST、固定error envelope、同一tab dispatch

### 実測済み

- Apple M4 / 24 GB / macOS 26.6.2 / arm64 / Python 3.14.7
- `mlx-lm 0.31.3`、`mlx 0.32.0`、`transformers 5.15.0`、`pip check`成功
- Qwen3-8B-4bit単体: prompt 11.294 tok/s、generation 17.776 tok/s、peak 4.707 GB
- server baselineでは`/health`、CORS、固定6ケース、20件直列の計26件成功（後続の実ID検証はMarkdown/URL条件未合格）
- 平均1.843秒、直列最大2.113秒、RSS 4,831,392 KB
- `127.0.0.1:8080`だけでlistenし、確認時の外部TCP接続なし
- Google Chrome headless temporary profileでunpacked load、service worker target `chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/service_worker.js`、popup page生成に成功
- 実ID `chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf` の`/health`とCORS preflightに成功
- `scripts/verify.py --origin <実ID> --count 1` はdaily/discord/code/japanese/prompt/serial成功、Markdown/URLの`**the patch**`不変条件は未合格

### 今回の対象外

- launchd LaunchAgentと運用手順

### 実装済み

- popupの全Discordタブ共通`enabled` toggle、既定OFF
- 現在表示中・新規messageごとの`翻訳`button、押下時だけの要求、pending連打抑止、成功・固定error・再試行UI
- Discord DOM候補selector、OFF cleanup、本文変更/content node差し替えのstale結果破棄、sender/input trust boundary
- concurrency 1、unique job最大64、queue待機120秒、bridge fetch/service worker job監督120秒
- SHA-256 key、重複Promise共有、最大256件・30分のmemory LRU cache
- MV3 manifest、実装対象ファイル、Node標準test、unpacked Chrome受入手順
- popup health/stateのNode test、固定health GET、content script失敗UIの固定error code表示
- Phase 5.6の既定bridge配線復旧、bridge/service worker timeout 120秒化、実Chrome検証

### 別作業として扱う項目
- 通常GUIでのpopup/service worker lifecycle（headless終了時に`content_verify_job`のpopup.html reason:1 logを1件観測）
- LAN上の別端末から接続できないこと
- 100件短文後のRSS推移
- スラング、複数文、Discord実データの目視翻訳品質
- Markdown/URLの`**the patch**`不変条件の再確認
- 不正JSONを含むprivacy markerがserver/client logへ残らないこと

### Phase 5.6で確認した実装差異と実測

- Phase 5.6実装前の実Chrome UIでは一部messageが成功し、一部が`request_timeout`となり、server側で応答write時の`BrokenPipeError`を確認した。
- sandbox内curl失敗はhost server停止の証拠ではなく、host側`/health`はHTTP 200、0.001118秒だった。
- Phase 5.6実装前の`extension/service-worker.js`では、`defaultTranslator`のbridge registry `requestImpl`が無効化され、既定経路がservice worker direct fetchとなっていた。
- Phase 5.6実装前のservice workerとbridgeのtimeoutはいずれも25秒だった。
- host serverへ180秒timeoutで固定7ケースを実行し、healthと6ケースは0.786〜2.131秒で成功、dailyは日本語条件で不合格だった。コマンド全体は25秒を超えて継続し、同じdaily短文の単独再実行はHTTP 200、1.371552秒だった。本文・応答は表示・保存していない。

## Scope

- 現行要求・仕様・設計・PRD・ADRの維持
- Chrome Extensionの最小実装とDiscord Web統合
- service worker所有のconcurrency 1 queue、有限timeout、response検証、最小cache
- 実Extension IDを使うlocalhost API結合
- LAN拒否、Chrome LNA/CORS、100件stress、privacy log、翻訳品質の検証
- 基本機能の合格後に限るlaunchd実装と検証
- 利用者向け導入・権限・操作・privacy・障害対応文書

## Out of scope

- LAN/Internet公開、multi-user、production serving
- 外部LLM/翻訳API、telemetry、analytics、本文保存
- FastAPI/Flaskまたは独自wrapper（実測上の必要が出た場合は再計画）
- Qwen3.5採用、queue 2、server-side cache、streaming、speculative decoding、複数model常駐
- Discordへの書込みや自動投稿

## Approach

1. current文書を要求・外部仕様・責務・製品目的に分離し、IDで追跡する。
2. Chrome公式仕様をread-only調査し、認証済みDiscord DOMは未確認の仮定として分離した上で、UI・job ID・queue/cache最小値を確定する。
3. content scriptはDOM/UI、button押下時だけの依頼、bridge document lifecycleを所有し、service workerはtrust boundary/queue/cache/payload/最終検証、bridgeは固定翻訳HTTP、popupはLNA用healthだけを所有する。
4. synthetic server試験とChrome/Discord実UI試験を分離して実行する。
5. 基本機能がすべて合格した後だけlaunchdを別承認・別フェーズで追加する。

長期判断は [ADR索引](../../adr/README.md) を正本とし、本計画へ判断理由を複製しない。

## Affected files

### 現在変更済み

- `requirements.txt`
- `scripts/start-server.sh`
- `scripts/verify.py`
- `.gitignore`
- `README.md`
- `docs/current/*.md`
- `docs/adr/*.md`
- `docs/plans/completed/2026-08-18-local-discord-translator.md`

### Phase 5承認対象

- `extension/manifest.json`
- `extension/service-worker.js`
- `extension/content-script.js`
- `extension/styles.css`
- `extension/popup.html`
- `extension/popup.js`
- `extension/popup.css`
- `extension/package.json`（ES module指定だけ、依存なし）
- `extension/tests/service-worker.test.js`（`node:test`、新依存なし）

### Phase 5.5承認・実装対象（完了）

- `extension/content-script.js`
- `extension/styles.css`
- `extension/tests/content-script.test.js`
- 実装後の状態同期に必要な`README.md`、`docs/current/*.md`、本plan、ADR-006

`extension/service-worker.js`、`extension/bridge.html`、`extension/bridge.js`、popup、manifest、server、依存関係は原則変更しない。これらの変更が必要と判明した場合は実装を停止し、理由と変更範囲を文書化して再承認を得る。

### Phase 5.6承認・実装対象（完了）

- `extension/service-worker.js`
- `extension/bridge.js`
- `extension/tests/service-worker.test.js`
- `extension/tests/bridge.test.js`
- 実装後の状態同期に必要な`README.md`、`docs/current/{REQUIREMENTS,SPECIFICATIONS,DESIGN}.md`、本plan、ADR-005

`extension/content-script.js`、popup、manifest、server、scripts、依存関係、`extension/service-worker copy.js`は変更しない。queue/cache上限・concurrency、API payload、`max_tokens`、sampling、permission、UIも変更しない。

### 承認済みLNA hotfix対象

- `extension/popup.js`
- `extension/popup.html`
- `extension/popup.css`
- `extension/content-script.js`
- `extension/tests/popup.test.js`（`node:test`、新依存なし）
- `extension/tests/service-worker.test.js`（既存固定error code契約に必要な場合だけ）
- `README.md`
- 内容が変わる`docs/current/*.md`、`docs/adr/004-popup-lna-bootstrap.md`、本plan

対象外はManifest permission、server、依存、翻訳payload、queue/cache値の変更である。
- `README.md`と内容が変わる`docs/current/*.md`、本plan

### 後続フェーズ候補

- launchd plist（Phase 6の別承認後に配置を確定する）

## Phases

### Phase 0: 文書体系の正本化

- 目的: 要求、仕様、設計、PRD、計画、ADRをDocuments規約に分離する。
- 前提: 原依頼、既存PLAN、README、実装を照合できること。
- 対象: `docs/current/`、本plan、`docs/adr/`、旧`docs/PLAN.md`移転案内。
- 対象外: source、test、設定、依存の変更。
- 完了条件: 要求→仕様→受入検証がIDで追跡でき、実装済み・未実装・未検証が一致する。
- 検証方法: 必須見出し・link・status検索、実装値との照合、`git diff --check`。
- 文書更新: 本phaseの全成果物。
- 未解決事項: なし。
- 次フェーズへの引き継ぎ: current文書を実装判断の正本として使う。

### Phase 1: 環境・model baseline

- 目的: Apple Silicon/MLX環境と初期modelを再現可能にする。
- 前提: server baseline実装の承認。
- 対象: `.venv`、固定依存、Qwen3-8B-4bit初回取得、version/Metal確認。
- 対象外: Qwen3.5比較、Chrome Extension。
- 完了条件: import、Metal、model generate、offline cacheが成功する。
- 検証方法: version、`pip check`、`mlx_lm.generate`、offline load。
- 文書更新: READMEの前提と初回取得。
- 未解決事項: Chrome/Discord同時利用時のmemory余裕。
- 次フェーズへの引き継ぎ: Qwen3-8B-4bitをbaselineに固定する。

### Phase 2: localhost server baseline

- 目的: 公式serverをprivacy境界内で起動する。
- 前提: Phase 1完了。
- 対象: start script、loopback、offline、CORS、thinking無効、concurrency 1、health/readiness。
- 対象外: 独自wrapper、server-side cache。
- 完了条件: offline起動・停止・再起動、chat completion、Extension形式originだけのCORSが成功する。
- 検証方法: `bash -n`、`lsof`、`/health`、chat completion、CORS preflight/POST。
- 文書更新: server仕様・設計・ADR-001/002。
- 未解決事項: 実Extension originとChrome LNA。
- 次フェーズへの引き継ぎ: server endpointとpayloadをExtension契約として固定する。

### Phase 3: server翻訳契約とbaseline検証

- 目的: 翻訳不変条件、error判定、直列安定性のbaselineを得る。
- 前提: Phase 2完了。
- 対象: 固定6ケース、response schema、thinking/truncation、20件直列、latency/RSS、通常ログ。
- 対象外: 実Chrome UI、100件stress、LAN別端末。
- 完了条件: 26件成功し、本文を表示・保存せず、結果混線がない。
- 検証方法: `scripts/verify.py`、self-check、process接続、RSS観測。
- 文書更新: baselineと未検証一覧。
- 未解決事項: スラング・複数文の目視、invalid JSON marker、100件RSS。
- 次フェーズへの引き継ぎ: Extensionは同じpayloadと成功判定を実装する。

### Phase 4: Chrome Extension調査・仕様確定

- 目的: 実装前にDiscord DOM、操作、権限、service worker lifecycleを確定する。
- 前提: current要求・仕様とADR-003が承認されていること。
- 対象: 現行Discord DOMのmessage識別、訳文表示位置、開始/停止UI、job ID、queue上限、timeout、最小cache、必要最小manifest権限。
- 対象外: source変更、queue 2、外部権限。
- 完了条件: 失敗時原文保持を含む観測可能なUI仕様、対象ファイル、テスト、手動検証が文書化される。
- 検証方法: Chrome/Discordのread-only調査、公式Chrome仕様照合、仕様trace review。
- 文書更新: `docs/current/REQUIREMENTS.md`、`SPECIFICATIONS.md`、`DESIGN.md`、`PRD.md`、ADR-003、本plan。
- 未解決事項: 当時は認証済みDiscord実UIの候補selectorとservice worker起点LNA promptを未確認としてPhase 5の受入試験対象にした。後者は実機失敗後、Phase 5.1とADR-004でpopup bootstrapへ改訂した。
- 次フェーズへの引き継ぎ: 本書のPhase 5対象ファイル・値・成功条件について明示承認を得てから実装する。

### Phase 5: Chrome Extension実装と結合検証

- 目的: Discord Webからlocalhost翻訳を利用可能にする。
- 前提: 本書に確定したPhase 5範囲の明示承認。
- 対象: 上記`Phase 5承認対象`のファイル。popup toggle、DOM候補検出、当時の自動翻訳UI、原文直下UI、sender/input検証、queue/cache/timeout、固定API payload、response検証、Node標準test、README。この自動翻訳UI判断はPhase 5.5で置換する。
- 対象外: queue 2、LAN公開、server wrapper、launchd。
- 完了条件: AC-001、AC-003、AC-004、AC-006、AC-009、AC-014の静的/Node自動検証部分が合格し、本文・訳文をstorage/logへ書く実装がない。当時の実Chrome結合は後続Phaseで検証する計画とした。
- 検証方法: `node --check`、`node --test`、manifest JSON parse、unpacked Extension、Discord実UI、実Extension IDのCORS/LNA、server停止・復旧、64件以下burst、duplicate coalescing、cache expiry/eviction。
- 文書更新: current文書、READMEのExtension導入・権限・操作・error・privacy。
- 結果: Extension実装、manifest/JS静的検証、Node queue/cache/schema test、headless unpacked load、service worker target/popup page生成、実ID `/health`/CORS preflight、文書同期を完了した。当時残ったservice worker fetch、LNA、Discord実UI、停止復旧は後続Phase 5.1〜5.6で検証を完了した。
- 未解決事項: DOM selectorとLNA promptは実UIでだけ確定できる。候補が不成立またはworker fetchがblockされた場合は完了扱いにせず、公式挙動と実測に基づき文書更新・再承認する。
- 次フェーズへの引き継ぎ: 完成したE2E経路をnetwork/stress最終検証へ渡す。

#### Phase 5 unpacked結合手順

1. `node --version`と`node -e "require('node:test')"`でpreflightし、`node --check`、`node --test extension/tests/*.test.js`、manifest JSON parseを実行する。
2. Chromeの`chrome://extensions`でDeveloper modeを有効にし、`Load unpacked`からリポジトリの`extension/`を選ぶ。
3. 表示された32文字のExtension IDをコピーし、`export CORS_ORIGIN="chrome-extension://<実ID>"`を設定する。
4. `./scripts/start-server.sh`を起動し、別terminalで`./.venv/bin/python scripts/verify.py --origin "$CORS_ORIGIN" --count 20`を実行する。
5. 認証済み`https://discord.com/`を開く。popupの初期状態がOFFで、訳文が挿入されないことを確認する。
6. DevToolsで候補selector `li[id^="chat-messages-"]` と配下の`[id^="message-content-"]`が実messageに一意に対応することを確認する。生成class名を代替selectorにしない。
7. popupをONにし、ChromeがloopbackへのLocal Network Access許可を表示した場合は許可する。許可UIが出ないままfetchがblockされる場合は実装を完了扱いにしない。
8. 現在表示中messageと新規message、通常文、複数行、code block、link、emojiで、原文直下の訳文、message対応、重複表示なしを確認する。
9. message編集、virtual scrollでのDOM削除・再生成、channel遷移中にstale訳文や別messageへの混線がないことを確認する。
10. serverを停止して原文保持と再試行buttonを確認し、同じ実IDのCORS設定でserver再起動後、buttonから復旧することを確認する。
11. 64件以下のburst、同一本文duplicate、cache hit/expiry/evictionはNode testで決定的に検証し、実UIでは順序混線と操作不能がないことを確認する。
12. `chrome.storage.local`に`enabled`以外がないこと、Extensionの各consoleとserver logに本文・訳文がないこと、OFFで挿入UIが消えて新規fetchが止まることを確認する。

manifest、service worker、content scriptを変更した場合は`chrome://extensions`でExtensionをreloadする。content script変更時はさらにDiscord tabをreloadする。popup HTML/JS/CSSだけの変更はExtension reload不要というChrome公式表を基準にするが、結合試験前には全体をreloadして同一条件にそろえる。

### Phase 5.1: popup LNA bootstrap hotfix（実装済み・実Chrome health成功）

- 目的: ChromeのLNA未許可によりservice workerのPOSTがserverへ到達しない問題を、利用者操作時の許可取得で解消する。
- 前提: Chrome公式仕様上、service workerはLNA promptを表示できず、Extension documentからlocal requestを発生させる必要がある。既存`GET /health`とhost permissionで足りる。
- 対象: `extension/popup.js`、`popup.html`、`popup.css`、`content-script.js`、`extension/tests/popup.test.js`、必要な既存test、README、current文書、本plan。
- 対象外: Manifest permission追加、server変更、新依存、content scriptからのHTTP、popupへの本文/訳文受渡し、queue/cache/payload変更。
- 実装方針:
  1. OFF→ON時にcheckboxをdisabledにして`接続確認中`を表示する。
  2. popup documentから定数`http://127.0.0.1:8080/health`へ5秒timeoutでGETする。
  3. LNA許可、HTTP 200、追加fieldのない`{"status":"ok"}`のときだけ`enabled=true`を保存する。
  4. `NotAllowedError`は`lna_denied`、自身のabortは`health_timeout`、他のfetch拒否は`health_network_error`、非200は`health_http_error`、JSON/schema不正は`health_invalid_response`へ正規化し、OFFを維持する。
  5. ON→OFFはhealthなしで即時`enabled=false`を保存する。
  6. content scriptはservice workerの既存固定error codeだけを失敗UIへ表示し、本文、response、`error.message`、URLを表示・logしない。
  7. popup状態遷移をpure export可能な最小構造にし、fetchとstorage境界をNode標準testで置換する。
- 完了条件: LNA許可+health成功時だけON、拒否・timeout・network・HTTP・schema失敗時はOFF、許可後にservice worker POSTがserverへ到達、Discord失敗UIで固定error codeを確認でき、本文・訳文がpopup/storage/logへ入らない。実Chrome healthは成功したが、POST以降はPhase 5.2のsender hotfix後に検証する。
- 自動検証: `node --check extension/popup.js`、`node --check extension/content-script.js`、`node --test extension/tests/*.test.js`、health正常/拒否/timeout/network/HTTP/schema/OFF状態遷移、既存queue/cache/response回帰、manifest JSON、`git diff --check`。
- 実機検証:
  1. server起動、Extension reload、Discord tab reload後、`enabled=false`を確認する。
  2. popupでON操作し、checkbox disabledと`接続確認中`、Chrome LNA promptを確認して許可する。
  3. health成功後だけONになり、serverへservice workerの`POST /v1/chat/completions`が到達して訳文が表示されることを確認する。
  4. LNA拒否またはserver停止ではOFFのまま固定codeが表示され、翻訳POSTが作られないことを確認する。
  5. ON→OFFがhealthなしで即時反映されることを確認する。
  6. service worker失敗時にDiscord UIへ既存固定codeだけが表示され、Extension各console、storage、server logに本文・訳文がないことを確認する。
- 文書更新: 実装後にcurrent文書の状態、READMEの初回許可・error code・復旧手順、本phaseの結果を同期する。
- 未解決事項: ChromeがLNA拒否を`NotAllowedError`として識別できない場合は`health_network_error`となる。権限追加やserver変更が必要と判明した場合は実装を停止し再計画する。
- 次フェーズへの引き継ぎ: hotfix合格後、Phase 6のprivacy・LAN・stress・品質検証へ進む。

### Phase 5.2: MessageSender URL検証 hotfix（実装済み・自動検証済み・実Chromeで後続`network_error`確認）

- 目的: popup health成功後も翻訳POSTが発生しない問題を、service workerの送信元URL検証で解消する。
- 結果: `validateSender`のURL参照を`sender.url`へ修正し、正規Discord top frameを受理すること、URL欠落・別origin・iframe・別Extensionを拒否することをNode testで確認した。実Chromeでは失敗UIが`network_error`へ進んだがbrowser由来の翻訳POSTはserverへ未到達であり、Phase 5.3へ引き継ぐ。
- 対象: `extension/service-worker.js`の`validateSender`、`extension/tests/service-worker.test.js`、本phaseに関係するcurrent文書。
- 対象外: `manifest.json`、content script、popup、server、依存関係、queue/cache、API payload、固定error code、権限追加。
- 実装方針:
  1. `sender.id === chrome.runtime.id`、`sender.frameId === 0`、整数の`sender.tab.id`を維持する。
  2. URLの参照元だけを`sender.url`へ変更し、scheme `https:`かつhostname `discord.com`を必須にする。
  3. 正規Discord top frameを受理する修正前失敗testと、URL欠落、別origin、iframe、別Extensionを拒否する回帰testを置く。
- 成功条件: 正規の`sender.url`を持つDiscord top frameがsender検証を通過して翻訳POST経路へ進み、URL欠落、別origin、iframe、別Extensionはfetch前に`invalid_sender`となる。
- 自動検証: `node --check extension/service-worker.js`、`node --test extension/tests/*.test.js`、manifest JSON parse、`git diff --check`。
- 実機検証: Extensionをreloadし、Discord tabをreloadしてONにする。healthはOFF→ON時の1回だけでよい。Phase 5.5実装後は対象messageの`翻訳`を押し、serverへ翻訳POSTが到達して訳文が原文直下へ表示されることを確認する。旧設計の自動要求は受入条件にしない。
- 文書更新: 実装・自動検証後にcurrent文書と本phaseの状態を同期した。当時残ったChrome実UIは後続Phase 5.4〜5.6で検証を完了した。
- Stop条件: 指定外ファイル、権限、server、依存関係、公開message/API契約の変更が必要なら実装せず再計画する。
- ADR: 既存のsecurity境界と責務分割を変更せず、Chrome API fieldの誤参照を正すだけなので新規ADRは作成しない。
- 実施結果: `extension/service-worker.js`、`extension/tests/service-worker.test.js`のみ変更。sender.id、frameId、整数tab.id、Discord HTTPS originの検証、queue/cache、payload、固定error codeは維持した。

### Phase 5.3: service worker error境界診断 hotfix（実装済み・自動検証済み・実Chromeで`network_error`確認）

- 目的: sender検証後の実Chrome UIで`network_error`となりPOSTがserverへ到達しない状態を、本文等を露出せずSHA-256境界とfetch境界へ分離する。
- 現状: popupのhealthは実Chromeで成功し、sender検証hotfix後のUIは`network_error`を表示する。一方、browser由来のPOSTはserverへ届かなかった。Phase 5.3でWeb Crypto不在・digest失敗を`hash_error`、fetchのLNA拒否を`lna_denied`、その他fetch拒否を`network_error`へ分類し、次の実Chrome調査境界を固定した。
- 対象: `extension/service-worker.js`、`extension/content-script.js`、`extension/tests/service-worker.test.js`と必要最小限の既存content script test、current要件・仕様・設計・PRD、本plan。
- 対象外: `manifest.json`、popup、server、依存関係、queue/cache設計、API URL/payload、権限追加、console/storage/log追加、本文・訳文・request/response・URL・`error.message`の表示または保存。
- 実装方針:
  1. service workerの固定`ERROR_CODES`へ`hash_error`と`lna_denied`を追加し、content scriptの表示allowlistを同期する。
  2. `sha256Hex`のWeb Crypto不在またはdigest失敗を`hash_error`へ正規化する。
  3. 翻訳POSTのfetch例外名が`NotAllowedError`または`SecurityError`なら`lna_denied`、自身の25秒abortなら既存`request_timeout`、その他fetch拒否なら既存`network_error`とする。既存の`TranslationError`、HTTP、response検証は変更しない。
  4. message境界とcontent scriptは未知の値を引き続き`network_error`へ正規化し、固定code以外の例外情報を返却・表示・log・storage保存しない。
  5. 新しい抽象化や診断logを追加せず、既存の`TranslationError`、`toErrorCode`、allowlistへ最小変更する。
- 成功条件:
  - SHA-256境界の失敗は`hash_error`、fetchの`NotAllowedError`/`SecurityError`は`lna_denied`、自身のabortは`request_timeout`、その他fetch拒否と未知値は`network_error`になる。
  - `hash_error`と`lna_denied`がmessage応答からcontent scriptの失敗UIまで固定codeのまま到達する。
  - 本文、訳文、request/response body、URL、`error.message`をUI、console、storage、通常logへ追加しない。
  - sender/input検証、queue/cache、API payload、HTTP/response error、popup health、Manifest、serverの既存動作を維持する。
- 自動検証: Web Crypto不在/digest失敗、`NotAllowedError`、`SecurityError`、timeout、generic fetch拒否、未知値の正規化をNode標準testへ追加し、`node --check extension/service-worker.js extension/content-script.js`、`node --test extension/tests/*.test.js`、manifest JSON parse、`git diff --check`を実行する。
- 実機検証結果: ExtensionとDiscord tabのreload後も`翻訳中…`から`network_error`となり、serverへbrowser由来POSTは到達しなかった。次の調査境界をservice workerのfetch実行文脈へ限定し、Phase 5.4へ引き継いだ。
- Stop条件: 指定外ファイル、権限、server、依存関係、queue/cache、API payload、privacy境界の変更が必要なら実装せず再計画する。
- ADR: 新規ADRは作成しない。service workerのHTTP/queue/cache所有、popup LNA bootstrap、privacy境界を変更せず、既存error境界の診断分類を細分化する局所的なhotfixだからである。

### Phase 5.4: Extension document translation bridge（実装・実Chrome検証完了）

- 目的: popup healthが成功してもservice worker fetchが送信前`network_error`となる実Chrome環境で、Chromeのsecurityを無効化せずbrowser由来翻訳POSTをlocalhost serverへ到達させる。
- 現状証拠: popup documentの`GET /health`は成功。server healthとExtension origin CORS preflightは正常。Phase 5.2 sender修正後に翻訳処理はfetch境界へ進み、Phase 5.3後も`network_error`、serverにbrowser由来OPTIONS/POSTなし。原因をservice workerのfetch実行文脈より先へは確定しない。
- 前提: [ADR-005](../../adr/005-extension-document-translation-bridge.md)の承認済み。Chrome公式上、web accessible resourceをorigin/resource単位で限定でき、iframe senderは自身のURL、tab、子frame IDを持つ。popup healthでExtension originのLNAは許可済みである。
- 対象実装:
  - `extension/manifest.json`: `bridge.html`だけを`https://discord.com/*`へ公開する`web_accessible_resources`を追加。
  - `extension/content-script.js`: ON時にhidden bridge iframeをtabへ1個作成、OFF時に削除。重複防止、load/削除、失敗UIの固定code同期。
  - `extension/bridge.html`, `extension/bridge.js`: Extension origin document、固定Port、固定API URL/method/header、25秒timeout、固定result envelope。page messageを受けない。
  - `extension/service-worker.js`: content sender検証を維持し、bridge Port senderのExtension ID、完全URL、origin、tab ID、正のframe IDを検証。tab対応job dispatch、切断処理、固定payload、HTTP/response最終検証、queue/cacheを維持。
  - `extension/tests/service-worker.test.js`, `extension/tests/content-script.test.js`, `extension/tests/bridge.test.js`: 下記回帰条件。
  - 実装後のREADME、current文書、本plan、ADR-003/005 status同期。
- 対象外: popup、server、CORS origin、host permission、推論payload値、queue/cache値、Discord originのCORS許可、`externally_connectable`、Offscreen API、Chrome security設定変更、新依存、自動retry、永続job。
- 通信契約:
  1. 正規Discord top-frame content requestを検証し、tab IDをjobへ関連付ける。
  2. service workerが固定payloadを構築し、同じtab IDの検証済みbridge Portだけへopaque job IDとpayloadを送る。
  3. bridgeはURL等を入力として受けず、定数localhost APIへPOSTする。
  4. bridgeはjob ID、HTTP status、200 JSONまたは固定error codeだけを返す。
  5. service workerがjob ID/envelope、HTTP、API schema、thinking/truncationを最終検証し、成功訳文だけを返却・cacheする。
- Security条件:
  - `web_accessible_resources`にwildcard、`bridge.js`、他originを含めない。
  - `window.postMessage`、page DOM event、任意URL/method/header/timeout/payloadをbridge入力にしない。
  - Portは`sender.id`、bridge完全URL/origin、整数tab ID、正の子frame IDを全検証し、正規content requestのtab IDと一致させる。tabごとに1Portだけ採用する。
  - 本文、訳文、payload、response、URL、例外messageをconsole、storage、通常logへ追加しない。
  - pageがbridge iframeを生成・削除できても、Extension制御の固定動作以外を起動できない。切断はavailability失敗として扱う。
- 状態/lifecycle:
  - ON: bridgeを1個作成する。bridge生成だけではPOSTしない。翻訳jobは利用者のbutton押下後、対応Port準備を有限時間だけ待てる。
  - OFF: observer/UIとbridgeを削除し、新規jobを作らない。in-flightは永続化せず、Port切断時は固定`bridge_unavailable`。
  - tab unload/channel navigation: iframe/Port切断を検出してtab登録を削除。新documentのcontent scriptが再作成する。
  - service worker再起動: Port再接続でtab登録を再構築する。queue/cache/in-flightを復旧保存しない。
- error: bridge未接続・切断は`bridge_unavailable`、bridge envelope不正は`invalid_response`。既存の`request_timeout`、`lna_denied`、`network_error`、`http_error`、API `invalid_response`を維持し、未知値は固定codeへ正規化する。
- 自動検証:
  - 正規/別ID/別URL/別origin/top-frame/欠落tab/重複Portの受理・拒否。
  - content request tabとbridge tabの一致、不一致時fetchなし、disconnect中のpending job失敗、再接続後の新規job。
  - bridgeの固定URL/method/header/body、25秒abort、network/LNA/HTTP/JSON error、未知job/envelope拒否。
  - queue順序、64件上限、120秒待機、dedupe、256件/30分cache、sender/input/payload/API schemaの既存回帰。
  - `node --check extension/*.js`、`node --test extension/tests/*.test.js`、Manifest JSON parse、公開resource/permission allowlist、`git diff --check`。
- 実Chrome検証:
  1. ExtensionとDiscord tabをreloadし、ONでbridge iframeが1個、Extension origin、hidden、正のframe ID、正規tab IDとして接続することを確認する。
  2. Phase 5.5実装後、対象messageの`翻訳`を押してserver access logでbrowser由来`POST /v1/chat/completions`を観測し、訳文を原文直下へ表示する。healthはOFF→ON時の1回だけでよい。
  3. 複数Discord tabで各1bridgeとなり、各content requestが同じtabのbridgeへだけ送られることを確認する。
  4. OFF、iframe削除、tab reload、server停止・再起動で原文保持、固定error、手動再試行復旧を確認する。
  5. bridge/page/SW console、`chrome.storage.local`、server通常logに本文・訳文が残らず、loopback以外の通信がないことを確認する。
- 成功条件: AC-001、AC-004、AC-006、AC-014、AC-016の本phase範囲が合格し、serverにbrowser由来POSTが届いて訳文が表示される。Chrome security、Discord CORS、permission、server、依存を広げない。
- Stop条件:
  - Discord CSP等で限定WARのbridge iframeがloadできない。
  - bridge Portの`sender.tab.id`または正の`frameId`が実Chromeで得られず、同一tab対応を安全に検証できない。
  - page message、`externally_connectable`、広いWAR/CORS、追加permission、Chrome security無効化、server変更、新依存が必要になる。
  - queue/cache/payload/privacy境界の拡大が必要になる。
- 文書更新: 実装・自動検証後にADR-005をAcceptedへ、ADR-003をSupersededへ変更し、current文書とREADMEを実装状態へ同期した。Phase 5.6実装後の実Chrome検証結果も同期した。
- 次フェーズへの引き継ぎ: Phase 5.6でbridge既定配線とtimeoutを是正し、実Chrome検証を完了した。

### Phase 5.5: メッセージ単位の手動翻訳UI（実装・自動検証・実Chrome検証完了）

- 目的: ON中の自動翻訳を廃止し、利用者が`翻訳`を押したメッセージだけを既存翻訳経路へ送る。
- 前提: [ADR-006](../../adr/006-manual-per-message-translation.md)と本phaseの対象・成功条件について明示承認済み。
- 対象: `extension/content-script.js`、`extension/styles.css`、`extension/tests/content-script.test.js`。実装後のREADME/current文書/本plan/ADR状態同期。
- 対象外: service worker、bridge、popup、manifest、server、API、permission、依存関係、queue/cache/security境界、server wrapper。
- 実装方針:
  1. ON時は既存bridgeとobserverを開始し、現在表示中・新規の翻訳可能なmessageごとに`翻訳`buttonを1つ作る。scan、DOM検出、button/bridge生成では`sendMessage`もPOSTも行わない。
  2. `翻訳`押下時だけ既存shapeのmessageをservice workerへ1回送り、buttonをdisabledの`翻訳中…`へ変更して連打を抑止する。
  3. 成功時は原文直下へ`lang="ja"`の訳文、失敗時は既存固定error codeと`再試行`を表示する。`再試行`押下だけが新しいmessage要求を作る。
  4. 本文変更・DOM差し替え時は旧結果を破棄し、ON中の新本文へ`翻訳`buttonを1つ作る。queue済みjobのcancel protocolは追加しない。
  5. OFF時はobserver/bridgeを停止し、button、loading、訳文、errorを除去して新規要求を送らない。
  6. service workerのcache hitはPOSTを発生させず、cache missだけが既存queue/bridge経路で固定APIへPOSTする。
- 成功条件:
  - 現在表示中・新規messageに各1個の`翻訳`buttonがあり、重複scanで増えない。
  - scanだけでは`chrome.runtime.sendMessage`も翻訳POSTも発生しない。
  - button 1回の押下につきcontent scriptから1要求となり、`翻訳中…`中の連打は追加要求を作らない。
  - 成功、失敗、`再試行`、OFF、本文変更、DOM差し替えでSPEC-EXT-001/002どおり遷移し、stale結果を表示しない。
  - 既存service worker/bridge/popup/API/permission/依存関係を変更しない。
- 自動検証: Node標準testで、scanだけではsendMessage/POSTなし、各message 1 button、クリック1回1要求、連打抑止、成功、失敗、再試行、OFF、本文変更・DOM差し替え時のstale破棄を検証する。`node --check extension/content-script.js`、`node --test extension/tests/*.test.js`、manifest JSON parse、`git diff --check`を実行する。
- 実施結果: `extension/content-script.js`、`extension/styles.css`、`extension/tests/content-script.test.js`だけを変更した。scan/DOM検出は各messageへbuttonを1つ表示するだけで要求せず、click 1回1要求、pending連打抑止、成功訳文、固定errorと再試行、OFF cleanup、本文変更/content node差し替えのstale破棄を実装した。service worker、bridge、popup、manifest、API、permission、依存関係は変更していない。
- 自動検証結果: `node --check`合格、content script test 8/8合格、Extension Node test 32/32合格、manifest JSON parse合格。
- 実Chrome検証: ONだけではserver access logに翻訳POSTがなく、各messageのbutton押下時だけcache missのPOSTが発生すること、成功/失敗/再試行、連打、編集、virtual scroll、channel遷移、OFFでのUI除去とPOST停止を確認した。
- 文書更新: 実装・検証結果に合わせてcurrent文書、README、本plan、ADR-006の実装状態を同期する。
- Stop条件: service worker/bridge/popup/manifest/server、公開API、permission、依存関係、queue/cache/security境界の変更が必要なら実装を停止し、再計画・再承認する。
- 次フェーズへの引き継ぎ: Phase 5.6でbridge既定配線とtimeoutを是正し、Phase 5.4〜5.6の実Chrome検証を完了した。

### Phase 5.6: bridge既定配線復旧と有限timeout是正（完了）

- 目的: `request_timeout`とserver側`BrokenPipeError`の連鎖を避けるため、設計済みbridge経路を復旧し、実測に基づく120秒の有限timeoutを実装する。
- 前提: 利用者の承認後に、測定結果に基づく120秒という実装値、本phaseの実装対象・成功条件どおりに実装した。sandbox内curl失敗をhost server停止と誤認せず、上記のhost health、実Chrome、server error、実装配線、固定case実測を診断根拠とする。
- 対象: `extension/service-worker.js`、`extension/bridge.js`、`extension/tests/service-worker.test.js`、`extension/tests/bridge.test.js`。実装後の本phase対象文書同期。
- 対象外: content script、popup、manifest、server、scripts、依存関係、`extension/service-worker copy.js`、API payload、`max_tokens`、sampling、permission、UI、queue/cache設計。
- 実装方針:
  1. `defaultTranslator`の既定`requestImpl`をbridge registryへ再接続し、実HTTP fetchはbridge documentだけが行う。service worker direct fetchを既定経路にしない。
  2. bridgeのfetch timeoutとservice workerのjob監督timeoutをともに120秒へ揃える。
  3. queue待機120秒は維持し、最大queue待ち120秒+実行120秒=240秒とする。Chromeの単一event/API call上限5分未満に収め、`onMessage`の非同期response channelとlong-lived Port messagingを維持する。
  4. 120秒は観測された25秒超tailを許容する有限上限とし、永続job、無限待ち、server-side cancellationを追加しない。
  5. cache、queue上限/concurrency、API payload、`max_tokens`、sampling、permission、server、UIを変更しない。
- 根本原因と復旧: 実装前は既定経路が設計済みbridgeを迂回し、25秒でclient側接続を閉じたため、server生成が後から完了すると応答write時に`BrokenPipeError`となった。bridge配線と120秒の両監督内でtailを完了させ、この連鎖を避ける。120秒超は`request_timeout`とする。実Chromeで境界条件と`BrokenPipeError`解消を検証した。
- 成功条件:
  - 旧実装では既定配線testが失敗し、修正後は`defaultTranslator`がbridge registryの`requestImpl`を使う。
  - 既定pathはservice workerのglobal fetchを呼ばない。
  - bridgeとservice workerのtimeoutが120秒で一致する。
  - fake timerで120秒未満はtimeoutせず、120秒到達時に`request_timeout`となる。
  - bridge result、HTTP/schema/error/disconnect、queue/cache/content UIの既存testsが維持される。
- 自動検証: 修正前失敗testを確認し、既定bridge配線、global fetch不使用、両timeout一致、120秒境界を含む対象test 22件とExtension全体35件が合格した。
- 実Chrome検証結果: 翻訳動作、25秒超case、120秒超case、`BrokenPipeError`解消、異常系を確認し、利用者がPhase 5.6の完了を受け入れた。
- 文書更新: 実装・Node自動検証・実Chrome検証後にADR-005、current文書、README、本planを完了状態へ同期した。
- Stop条件: content script/popup/manifest/server/scripts/依存関係/`service-worker copy.js`、公開API、permission、queue/cache、payload、UIの変更が必要なら停止し、再計画する。
- 次フェーズへの引き継ぎ: なし。

### Phase 6: privacy・LAN・stress・品質（今回の完了範囲外）

これらは手動翻訳変更とPhase 5.6是正の完了条件から除外し、別依頼がある場合だけ新しいplanで扱う。

### Phase 7: launchd（今回の完了範囲外）

launchdは別承認対象のまま本作業から除外し、本planの完了条件には含めない。

### Phase 8: 完了レビュー（完了）

- 目的: 製品と文書の一致を確認し、planを履歴化する。
- 前提: 今回対象の手動翻訳とbridge/timeout是正の要求・受入条件が合格。
- 対象: 今回対象のrequirement/spec/validation trace、差分、検証結果、利用者手順。
- 対象外: 新機能。
- 完了条件: 今回対象に未実装・未検証がなく、Outcomeが確定し、本planを`plans/completed/`へ移動できる。
- 検証方法: repo所定検証、Node test、Chrome実UI、timeout/異常系、`git diff --check`。
- 文書更新: current文書、Outcome、completed plan。
- 未解決事項: なし。
- 次フェーズへの引き継ぎ: なし。

## Success criteria

- 手動翻訳UIとPhase 5.6 bridge/timeout是正の要求・仕様・検証結果が追跡できる。
- 対象実装とcurrent文書が一致する。
- Node自動検証と実Chrome検証が合格する。
- 利用者が動作確認結果を受け入れる。

## Validation

| 領域 | 最小検証 | 現在 |
|---|---|---|
| 構造 | shell構文、Python compile/self-check、manifest/JS検査 | server/Extension、headless unpacked load、worker target/popup page生成合格 |
| API | health、chat schema、thinking、truncation、CORS | synthetic試験合格 |
| 翻訳 | 固定ケースとDiscord実文の目視 | 手動翻訳変更の実Chrome検証合格。過去のMarkdown/URL単体baselineは今回の完了判定外 |
| Chrome | popup health→LNA許可、scan時要求なし、button→worker→bridge→localhost→表示、実origin、120秒timeout | Phase 5.4〜5.6の翻訳、25秒超・120秒超境界、`BrokenPipeError`解消、異常系を実Chromeで検証済み |
| Privacy | offline、E2E外部接続なし、body markerなし | server通常経路のみ一部合格 |
| Network | loopback listener、LAN別端末拒否 | listener合格、LAN未実施 |
| Stability | 20件、100件、順序、RSS | 20件合格、100件未実施 |
| Lifecycle | foreground stop/restart、launchd login/restart/stop | foreground合格。launchdは今回の対象外 |
| Repository | repo所定check、`git diff --check` | 文書修復後に再実行 |

## Risks

- Discord DOM変更でmessage識別や表示位置が壊れる可能性に対し、DOM責務をcontent scriptへ限定し、候補selectorと状態遷移をNode test・実Chromeで検証した。
- message編集や仮想scrollでbuttonまたは旧結果が重複・混線する。content nodeごとの状態と本文一致をcontent scriptで検証し、Node testと実Chromeで確認する。
- Chrome Local Network AccessまたはExtension lifecycleが想定と異なる。popup documentの固定health GETで実Chrome UIを確認し、権限・wrapper追加を推測で行わない。
- service worker direct fetchへの配線退行はbridge設計を無効化し、30秒fetch response制約とLNA差異を再導入する。既定配線testとglobal fetch不使用testで固定する。
- timeoutを短く戻すとserver生成中にclient接続だけが閉じて`BrokenPipeError`が再発し得る。bridge/service workerを同じ120秒にし、fake timerと25秒超実Chrome caseで検証する。
- `runtime.MessageSender`のfieldを誤ると正規content scriptを拒否する。送信元page/frame URLは`sender.url`だけを正本とし、他のsender境界を維持してNode testで固定する。
- `mlx_lm.server`の部分互換、logging、concurrency issueを引き継ぐ。短い非streaming、同一parameter、concurrency 1に限定する。
- service worker停止でin-flight jobやmemory cacheが失われる。復旧仕様をPhase 4で明示する。
- Qwen翻訳品質がslangや長文で不足する可能性がある。model変更前に同一caseで比較する。
- CRITICAL logは可観測性を下げる。本文なしerror logが必須なら計画・ADRを更新して再承認する。
- launchd restart loopやlog肥大化の可能性がある。基本機能完了後に独立検証する。

## Progress

- 完了フェーズ: Phase 0、Phase 1、Phase 2、Phase 3、Phase 4、Phase 5（旧自動翻訳UIの静的実装・Node自動検証）、Phase 5.1実装・自動検証・実Chrome health確認、Phase 5.2実装・自動検証、Phase 5.3実装・自動検証、Phase 5.4〜5.6実装・Node自動検証・実Chrome検証
- 次のフェーズ: なし
- 変更済み実装ファイル: `.gitignore`、`README.md`、`requirements.txt`、`scripts/start-server.sh`、`scripts/verify.py`、`extension/*`
- 変更済み文書: `docs/current/*`、`docs/adr/*`、本plan、`docs/PLAN.md`移転案内
- 未解決事項: 今回の完了範囲にはなし
- 実行済み検証: 26件server baseline、実IDの`/health`/CORS preflight、headless unpacked load、worker target/popup page生成、Phase 5.6対象test 22件、手動翻訳UIを含むExtension全体Node test 35件、manifest JSON parse、Phase 5.6実装後の実Chrome翻訳、25秒超・120秒超境界、`BrokenPipeError`解消、OFF・切断・復旧、本文非保存、異常系、host health HTTP 200/0.001118秒、固定7ケースの180秒枠実行とdaily単独HTTP 200/1.371552秒、本文・応答非表示・非保存、offline再起動、loopback listener、確認時外部TCPなし、shell/Python/self-check、`git diff --check`
- 次に必要な検証: なし

## Decisions

- 公式server直接利用: [ADR-001](../../adr/001-use-official-mlx-lm-server.md)
- loopback/offline privacy境界: [ADR-002](../../adr/002-loopback-offline-privacy-boundary.md)
- service worker queue/cache所有: [ADR-003](../../adr/003-service-worker-owns-queue.md)
- popup LNA bootstrap: [ADR-004](../../adr/004-popup-lna-bootstrap.md)
- Extension document bridge: [ADR-005](../../adr/005-extension-document-translation-bridge.md)（Accepted, implemented; Chrome translation verified）
- メッセージ単位の手動翻訳: [ADR-006](../../adr/006-manual-per-message-translation.md)（Accepted, implemented and verified）
- Initial model: Qwen3-8B-4bit。configurableであり、Qwen3.5採用判断ではない。
- Initial generation: non-thinking、non-streaming、`temperature=0.7`、`top_p=0.8`、`top_k=20`、`min_p=0`、`max_tokens=512`。
- Extension initial policy: 既定OFF、queue 1、unique job最大64、queue待機120秒、bridge fetch/service worker job監督120秒、memory LRU 256件・30分、service worker終了時破棄。
- queue 2、独自wrapper、launchd詳細は未決定である。

## Outcome

手動翻訳UI、popup health、sender URL修正、error境界分離、Phase 5.6のbridge配線復旧と120秒化を実装し、Node自動検証と実Chromeの翻訳・timeout境界・異常系検証を完了した。利用者が全検証結果を確認し、本作業のOutcomeを完了として受け入れた。launchd等は今回の完了範囲に含めない。

## Official references reviewed on 2026-08-18

- https://github.com/ml-explore/mlx-lm/releases/tag/v0.31.3
- https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/SERVER.md
- https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/server.py
- https://ml-explore.github.io/mlx/build/html/install.html
- https://huggingface.co/Qwen/Qwen3-8B
- https://huggingface.co/mlx-community/Qwen3-8B-4bit
- https://huggingface.co/Qwen/Qwen3.5-9B
- https://huggingface.co/mlx-community/Qwen3.5-9B-4bit
- https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables
- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- https://developer.chrome.com/docs/extensions/reference/manifest
- https://developer.chrome.com/docs/extensions/reference/manifest/background
- https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- https://developer.chrome.com/docs/extensions/reference/api/storage
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked
- https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing
- https://developer.chrome.com/blog/local-network-access
- https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources
- https://developer.chrome.com/docs/extensions/reference/api/runtime
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac
- mlx-lm issue reports: https://github.com/ml-explore/mlx-lm/issues/1472, https://github.com/ml-explore/mlx-lm/issues/1493, https://github.com/ml-explore/mlx-lm/issues/854, https://github.com/ml-explore/mlx-lm/issues/1641
- 実施結果: `extension/service-worker.js`で`hash_error`/`lna_denied`を固定error codeへ追加し、SHA-256失敗と`NotAllowedError`/`SecurityError`を分類した。`extension/content-script.js`のallowlistを同期し、既存testsへWeb Crypto、fetch拒否、timeout、未知値、message境界の回帰条件を追加した。当時の実Chrome表示code、翻訳POST、訳文表示は後続Phase 5.4〜5.6で検証を完了した。
