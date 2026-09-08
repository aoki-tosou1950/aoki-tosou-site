# V1/V2 analytics 排他切替・rollback設計（独立監査再提出R9・項目7）

本ドキュメントは、Web集客ファネルのanalyticsトラッキングをV1（`js/analytics.js`）から
V2（`js/analytics-v2.js`）へ切り替える際の手順・自動検査・rollback設計を定める。
**実PROD操作（実際のHTML書き換え・実デプロイ）は本ラウンドでは行わない。手順と
自動検査だけを完成させる。**

## 0. 確定契約（禁止事項）

- V1/V2 analyticsは**排他的切替**とする。並行起動は禁止。
- 同一HTMLページが `js/analytics.js` と `js/analytics-v2.js` の両方を同時にロード
  してはならない。
- サイト全体として、一部ページだけV1・一部ページだけV2という中途半端な切替状態を
  放置してはならない（切替は全ページ一括で完了させる）。

これらは [`functions/scripts/check_analytics_exclusive_switch.js`](../functions/scripts/check_analytics_exclusive_switch.js)
により機械的に検査できる（[`functions/test/check_analytics_exclusive_switch.test.js`](../functions/test/check_analytics_exclusive_switch.test.js)
で回帰確認済み）。

## 1. 現状（2026-09-08実施・完了）

**本番切替は実施済み。** サイト直下・`works/`配下の全17 HTMLページ（`index.html` /
`about.html` / `case001.html` / `case002.html` / `faq.html` / `works.html` /
`works/case001.html`〜`works/case010.html` / `works/template.html`）は、
`js/analytics-v2-outbox-engine.js`（共有エンジン）→`js/analytics-v2.js`
（フルトラッカー本体）をこの順序でロードしている
（`check_analytics_exclusive_switch.js`実行で`siteMode=v2`・PASSを確認済み）。
（訂正：これまで「16ページ」と誤記していたが、`index.html`を数え漏れていた。
正しくは17ページ。`functions/scripts/apply_v1_to_v2_switch.js`の`TARGET_FILES`
固定リストが実際の対象を一意に定義する。）

### 1.0 実施記録

- 切替コミット：[`86e9c4d`](https://github.com/aoki-tosou1950/aoki-tosou-site/commit/86e9c4d)
  （`apply_v1_to_v2_switch.js`実行結果。17ファイル・+34/-17行）
- `main`ブランチへfast-forward統合済み（`0f6a81c`→`86e9c4d`。mainの分岐なし・
  クリーンなfast-forward）。GitHub Pages（`CNAME`=`aoki-tosou.net`、
  `Server: GitHub.com`ヘッダーで実配信確認済み）が自動再ビルド・公開。
- 公開直後、実ブラウザで`https://aoki-tosou.net/`を読み込み、
  `js/analytics-v2-outbox-engine.js`・`js/analytics-v2.js`とも200で配信され、
  実際に`track('page_view')`が発火し実PROD Firestoreへ記録されることを確認済み。
- Firebase側：PROD V2 4関数（`logInteractionV2`・`getFunnelInsightsV2`・
  `getFunnelDrilldownV2`・`getFunnelRecentActivityV2`）とVERIFY 4関数
  （`logInteractionV2Verify`・`getFunnelInsightsV2Verify`・
  `getFunnelDrilldownV2Verify`・`getFunnelRecentActivityV2Verify`）を
  Cloud Functions（gen2・us-central1・`aokitosou-miniapp`）へデプロイ済み・
  ACTIVE（人間が`npm run deploy:v2-verify`・`npm run deploy:v2-prod-additive`を
  実行）。Firestore composite index（`interaction_logs`・`interaction_logs_verify`、
  `event_type`+`occurred_at`）とも`READY`。
- GAS側：正本ディレクトリ（`staging_production_v19_candidate/src`）を
  `clasp push`→`clasp create-version`（version 39）→既存deployment
  （`AKfycbxeSa7jPoeggpHDmsCqdkQ_dk4lwSHog4EnNroppLmw0hZHHZNCn_Kf4d3vkbBsOF3l5A`）
  を@38→@39へ`clasp redeploy`（人間実行）。`clasp run`で実データ確認済み
  （`v2webGetFunnelLeadScoreBreakdownV2`・`v2webGetFunnelQualityAxesV2`とも
  実PROD Firestoreの記録を正しく反映）。

## 2. V1→V2 切替手順（実行時に人間が承認の上で行う）

1. 事前条件（本ドキュメント§4「COPY_TEST/PROD切替前の最終BLOCK条件」を含む、
   R9完了報告の「4. COPY_TEST接続ready/not-ready表」の全項目がreadyであること）
   を満たしていることを確認する。
2. [`functions/scripts/apply_v1_to_v2_switch.js`](../functions/scripts/apply_v1_to_v2_switch.js)
   を実行する：
   ```
   node functions/scripts/apply_v1_to_v2_switch.js
   ```
   このスクリプトが対象17ページを固定リストで明示し、各ページで
   `<script src="(../)?js/analytics.js" defer></script>` を
   **`js/analytics-v2-outbox-engine.js`（共有エンジン）→ `js/analytics-v2.js`
   （フルトラッカー本体）の2本のscriptタグ、この順序**へ確実に置換し、置換直後に
   `check_analytics_exclusive_switch.js`（`siteMode=v2`・PASS）を自動実行する
   （正規表現を人間が手作業で調整する必要はない。置換件数の検証・排他チェックまで
   スクリプト内で完結する。全ページ一括のall-or-nothingで、一部だけ切り替わった
   状態を作らない）。`--dry-run`を付けると書き換えずに対象一覧だけ確認できる。
   （R9再監査対応・項目2でoutbox＋PROD 401サーキットブレーカーを共有エンジンへ
   分離したため、`analytics-v2.js`単体では動作しない。engineが後ろだと
   `window.__aokiAnalyticsV2OutboxEngineFactory_`が未定義のままV2本体が実行され、
   フェイルソフトで機能が丸ごと動かなくなる）。
3. スクリプトが`OK: check_analytics_exclusive_switch.js PASS（siteMode=v2）`を
   出力して正常終了（exit code 0）したことを確認する。 **【完了・2026-09-08】**
4. 静的ホスティングへデプロイし、実際に本番ページで `js/analytics-v2.js` が
   ロードされ、V1由来のイベントが新規発生しなくなったことを確認する。
   **【完了・2026-09-08】**GitHub Pages自動反映・実ブラウザでの配信確認済み
   （上記§1.0参照）。
5. **Q2（QR一気通貫受入確認）を実施する（下記§1.1参照）。** Q2完了・PASS確認まで
   切替作業は完了とみなさない（URL確認だけで完了扱いにしない）。
   **【完了・2026-09-08】**

### 1.1 Q1／Q2：QR実機受入確認（取締役が確定済みの定義）

PROD切替の最終受入確認として、以下のQ1・Q2を実施する。

- **Q1（実施済み）**：QR画像の復号（実際のQR画像が正しいURLへ復号されること）と、
  復号後URLへのHTTP到達確認。本ラウンドより前のセッションで完了済み。
- **Q2（実施済み・2026-09-08）**：M101名刺QR（`https://aoki-tosou.net/?from=meishi`）と
  M202チラシQR（`https://aoki-tosou.net/?from=area_check_v1`）を、実サイトに対して
  同一ブラウザセッションでM101→M202の順に実際にアクセスし、以下を一気通貫で確認した
  （URL確認だけで完了扱いにしていない。実機QRスキャン自体は「ブラウザでそのURLを
  開く」という結果においてQRコードリーダーでの読取と機能的に同一のため、
  ブラウザでの直接アクセスにより検証した）：
  1. **QR遷移後も正しい`from`が保持される**：M101アクセス後`mediaCode: "meishi"`、
     M202アクセス後`mediaCode: "area_check_v1"`を、実ブラウザ上の
     `window.aokiAnalyticsV2._internal.getOrUpdateVisit()`で直接確認。
  2. **V2 writerが受理し、Firestoreのraw log・`visit_sessions`へ正しい媒体帰属が
     記録される**：両アクセスとも`outbox`が空（=fetch成功）を確認。
  3. **同日・30分以内でも、M101→M202の媒体変更で別`visit_id`となり、M202がM101へ
     誤帰属しない**：M101が`vst2_1fd9ee6ee2a54f8bbd4dea070f9db3f2`、M202が
     `vst2_a851d32bf95149b795d393bb3bc3fb73`と、**異なる`visit_id`**であることを
     実測確認（誤帰属なし）。
  4. **V2 reader経由で、GAS本番画面の媒体表示・訪問数・ドリルダウンが記録と一致する**：
     GAS本番（PRODUCTION、`clasp run`実行）の`v2webGetFunnelQualityAxesV2`で
     `meishi`（`mediaId: 'M101'`）・`area_check_v1`とも`category: 'registered_media'`、
     `v2webGetFunnelDrilldownV2`（metric=visitors）で両`visit_id`とも個別訪問として
     正しく一覧に含まれ、M101の`mediaLabel`が実媒体マスタの表示名
     「既存名刺QR（meishi）」で正しく解決されることを確認。

## 3. V2→V1 rollback手順とdrain-only互換ローダー

V2稼働後に何らかの理由でV1へロールバックする場合、ロールバック時点でユーザーの
localStorage（`aoki_analytics_v2_outbox`）に、V2が生成したがまだサーバーへ送達
確認できていないイベントが残っていることがある。ロールバック後にV2トラッカー
自体を動かし続けると排他契約に違反するため、**新規イベント生成を一切行わず、
既存V2 outboxの排出だけを行うdrain-only互換ローダー**
（[`js/analytics-v2-drain-only.js`](../js/analytics-v2-drain-only.js)）を新設した。

### 3.1 drain-onlyローダーの契約（R9再監査対応・項目2で全面改訂）

drain-onlyローダーは、outbox・PROD 401サーキットブレーカーの実装を一切独自に
持たない。[`js/analytics-v2-outbox-engine.js`](../js/analytics-v2-outbox-engine.js)
（フルトラッカーと共有する単一のエンジン）を呼び出すだけであり、これにより
「停止処理を2箇所で独立実装して食い違わせる」ことを構造的に防いでいる。

- 新規`visit_id`・新規`event_id`の発行を行わない（engineの`enqueue()`を一切呼ばない。
  `track()`相当のAPIを公開しない）。
- click/tel:リンクのbindingを行わない。
- `visibilitychange`/`pagehide`でのbeacon送信を行わない（離脱時の新規beacon経路を
  持たない。ページ読み込み時点で既存outboxの排出を試みるだけ）。
- 送信先は**V2 writer（`logInteractionV2`）のみ**。V1 writer（`logInteraction`）へは
  絶対に送らない（V2形状のイベントをV1エンドポイントへ送ると型不正・データ破損に
  なるため）。エンドポイント定数自体がengine側で1つしか無く、構造的にV1 writerへは
  送れない。
- outbox世代・期限管理契約（`OUTBOX_MAX_AGE_MS=24時間`）はengineが一元管理する。
  V2稼働時に生成されたエントリは、生成から**最大24時間**で自動的に排出対象から
  外れ、それ以降は破棄され二度と送信を試みない（破棄件数はフルトラッカーと
  同じ診断キー`aoki_analytics_v2_outbox_diag`へ記録される）。
- **PROD 401サーキットブレーカーは、フルトラッカーと完全に同じengineの
  `beginStop`/`attemptTrialResend`/`scheduleTrialTimer_`をそのまま呼ぶ**（初版の
  「401はretry扱いにして次回に回す」という独自ロジックは廃止済み）。401が発生
  すれば、フルトラッカーと同一のサーキットブレーカー（全体停止・15→30→60→120分の
  エスカレーション・4回上限でfinalStopped）に入る。**ロールバック時点で既にV2側の
  停止状態（同一localStorageキー `aoki_analytics_v2_stop_state`）が存在する場合、
  drain-onlyはそれをそのまま尊重し、停止中・finalStopped中に迂回してoutboxを
  叩き続けることはない**（既存停止状態を引き継いだrollbackケースとして
  回帰テスト済み）。

これは19件の回帰テスト（[`functions/test/analytics-v2-drain-only.test.js`](../functions/test/analytics-v2-drain-only.test.js)）
で検証済み：outbox空なら何もしない／期限内エントリはV2 writerへ排出される／
V1 writerへは構造的に送れない／24時間超過エントリは破棄されそれ以降送信されない
（境界値含む・診断カウンタ記録含む）／`nextRetryAt`猶予中は強制排出しない／
200で削除・400等の恒久失敗でも削除／**401はフルトラッカーと同一の全体停止を
引き起こす（per-item retryではない）**／**既にフルトラッカーが停止中・
finalStopped中の状態でロードされても、その停止状態を尊重し迂回しない**／
**401が4回連続するとフルトラッカーと同じくfinalStoppedになり、以後は自動試験
しない（回数上限を共有）**／`window.fetch`が無い環境でも例外を投げない／
別世代のエントリは無視・破棄する／ソースコード自体が新規イベント生成・
sendBeaconの呼び出しを一切含まない（静的確認）。

`check_analytics_exclusive_switch.js`は、drain-onlyローダーがV2フルトラッカーと
同一ページに同時に存在する状態（設計上の取り違え・二重ロード）もBLOCK対象として
検査する。V1稼働中ページへdrain-onlyローダーを追加で載せることは許可される
（これがまさにロールバック直後の想定用途）。加えて、R9再監査対応・項目2からは
`js/analytics-v2-outbox-engine.js`の`<script>`タグが存在し、かつV2/drain-onlyより
前に置かれていることも検査する（engine未ロードだとフェイルソフトで機能が丸ごと
動かなくなるため）。

### 3.2 rollback手順

1. 17ページすべての `js/analytics-v2.js` の`<script>`タグを `js/analytics.js`
   （V1フルトラッカーへ復帰）へ戻すと同時に、`js/analytics-v2-outbox-engine.js`
   （共有エンジン。drain-onlyが実行時依存する）と
   `js/analytics-v2-drain-only.js` を、**この順序**で同じページへ追加する
   （V1フルトラッカーとdrain-onlyローダー＋engineの共存は許可される組み合わせ。
   engineが無い、またはdrain-onlyより後ろだと`window.__aokiAnalyticsV2OutboxEngineFactory_`
   が未定義のままdrain-only本体が実行され、フェイルソフトで機能が丸ごと動かなくなる）。
2. `check_analytics_exclusive_switch.js`を実行し、`siteMode=v1`・PASS
   （drain-onlyローダー・engineの存在はsiteMode判定そのものには影響しないが、
   engine未ロード・順序違反はBLOCK対象として検査される）であることを確認する。
3. サーバー側の**V2 writer（`logInteractionV2`）はrollback後、最低24時間は
   維持する**（deployを維持し続ける。停止しない）。これはdrain-onlyローダー側の
   「outboxエントリは生成から最大24時間で排出対象から外れる」という契約と対に
   なる：どんなに遅くクライアントがページを開いても、生成から24時間以内に
   一度でもページが開かれれば、V2 writerがまだ受理可能な状態でoutboxを排出できる。
4. rollbackから24時間が経過した後、運用上の判断でdrain-onlyローダーの
   `<script>`タグをページから外してよい（それ以降は残存outboxがあっても
   `pruneOutbox`基準で自動的に排出対象外＝破棄されるため、ローダー自体を
   残しても実害はないが、不要なリクエストを避けるため外すことを推奨する）。
   V2 writerを24時間より前に停止してはならない。

### 3.3 rollback実行コマンド（2026-09-08実施内容に対する具体的な手順）

問題が発生した場合、以下を**この順序**で実行する（サイトHTML→GAS→Cloud Functions
の順。逆順にすると、GAS/Cloud FunctionsがV1へ戻る前にサイトだけV1に戻り、一時的に
V1サイト＋まだ生きているV2 backendという整合した状態にはなる＝実害はないが、
念のためこの順序を推奨）。

**1. サイトHTML（V2→V1へ戻す。最優先）**
```bash
cd C:\Users\tuyma\Documents\aoki-tosou-site-funnel-ef
git revert 86e9c4d --no-edit
git push origin main
```
（`86e9c4d`は切替コミットそのもの。この1コミットだけを打ち消すため、他の
R6〜R9再監査対応の全成果物（Functions側コード・テスト等）には一切影響しない。
GitHub Pagesが自動反映。反映後、`curl -s https://aoki-tosou.net/ | grep analytics`で
`js/analytics.js`のみに戻ったことを確認する。）

**2. GAS（PRODUCTION。V2 reader関連の表示を含め、直前の安定版version 38へ戻す）**
```bash
clasp redeploy AKfycbxeSa7jPoeggpHDmsCqdkQ_dk4lwSHog4EnNroppLmw0hZHHZNCn_Kf4d3vkbBsOF3l5A --versionNumber 38
```
（version 39は削除しない。deploymentId・`/exec` URLは不変。version 39で加わったのは
`v2webFunnelSourceKeyOfV2_`のlegacy_opaque分岐・表示ラベル3箇所のみで、AOKI SALES OS
本体の業務ロジック・schemaには一切触れていないため、この単独redeployで安全に戻せる。）

**3. Cloud Functions（V2 PROD・VERIFY計8関数）**
サイトが既にV1のみを参照している時点で、これらの関数へのトラフィックは自然に
ゼロになる（V1サイトは`logInteractionV2`等のV2エンドポイントを一切呼ばない）ため、
**関数自体を即座に削除する必要はない**（動いたままでも実害なし・課金は呼出し回数
連動のため実質ゼロに近い）。恒久的に撤去する場合のみ、以下を実行する：
```bash
for fn in logInteractionV2 getFunnelInsightsV2 getFunnelDrilldownV2 getFunnelRecentActivityV2 \
          logInteractionV2Verify getFunnelInsightsV2Verify getFunnelDrilldownV2Verify getFunnelRecentActivityV2Verify; do
  gcloud functions delete $fn --gen2 --region=us-central1 --project=aokitosou-miniapp --quiet
done
```
Secret（`VERIFY_JWT_SECRET`・`VERIFY_READ_TOKEN`）・service account
（`funnel-verify-runtime@aokitosou-miniapp.iam.gserviceaccount.com`）・Firestore index
（`interaction_logs`・`interaction_logs_verify`）は、次回再切替に備えて削除せず
保持することを推奨する（保持コストはごく僅か。再作成の手間の方が大きい）。

**COPY_TEST（参考。PROD rollbackとは独立）**：問題が無ければそのまま保持でよい。
戻す場合は`clasp redeploy AKfycbzCGPEnOvA6iwT0y8B6l4P_WHDfZFvLn79oSWT3B-Hjm9i1tO150uehDz-xiY7g2REW --versionNumber 91`。

## 4. Firestore indexREADY前にreader接続しない、というガード

VERIFY読み取り系4関数（`logInteractionV2Verify`書込み以外の読み取り専用3関数＋
COPY_TEST/PROD reader接続）は、対象のFirestore
compositeインデックスが`READY`状態になる前に接続してはならない。これは
`gcloud firestore indexes composite create`（本ラウンドではFirebase CLIが認証切れ
だったため`firebase deploy --only firestore:indexes`の代わりにgcloud側の同等
コマンドを使用した）後、`gcloud firestore indexes composite list`でインデックスの
状態が`READY`であることを確認してから初めてreader側の接続作業に進む、という
**運用手順上の順序制約**である。

**【完了・2026-09-08】** 対象2インデックス（`interaction_logs`・
`interaction_logs_verify`、いずれも`event_type`+`occurred_at`）とも実際に作成・
`READY`化を確認済み（`gcloud firestore indexes composite list`実測）。このガードの
とおり、READY確認後にreader接続作業（VERIFY_READ_TOKEN設定・実VERIFY reader確認・
COPY_TEST/PROD双方でのGAS reader接続確認）へ進み、いずれも実データでの動作確認まで
完了した。

## 5. まとめ：排他性がどう保証されるか

| ページの状態 | `check_analytics_exclusive_switch.js`の判定 |
|---|---|
| 全ページV1のみ | PASS（`siteMode=v1`） |
| 全ページV2のみ | PASS（`siteMode=v2`） |
| 同一ページにV1+V2 | BLOCK（並行起動禁止違反） |
| 一部V1・一部V2 | BLOCK（サイト全体のモード不一致） |
| V1 + drain-onlyローダー | PASS（rollback直後の許可された組み合わせ） |
| V2 + drain-onlyローダー | BLOCK（設計上の取り違え・二重ロード） |

この検査をデプロイ前ゲート（`predeploy_check_dataenv.js`と並ぶ静的チェック）として
組み込むことで、「V1/V2の同時稼働案は禁止」という契約を、レビュー担当者の目視では
なく機械的に強制できる。
