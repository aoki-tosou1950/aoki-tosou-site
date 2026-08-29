# 青木塗装 集客ファネル v1

## データ契約

日別の集計正本は Firestore の `funnel_daily/{YYYY-MM-DD}`。サイトイベントの重複排除は同日の `events/{eventId}`、匿名訪問者の重複排除は `visitors/{sha256(日付:匿名ID)}`、LINE webhook は `line_events/{webhookEventId}` を使う。IP、LINE userId、氏名、電話、住所は集計領域へ保存しない。

フォーム原本は既存の `submissions` / `other_inquiries`、サイト計測の監査ログは既存の `interaction_logs`。経営ダッシュボードは個票を読まず、期間内の `funnel_daily` と `funnel_sales_daily` だけを読む。自動ポーリングは行わず、初回表示と期間切替時だけ取得する。

営業OSは `funnel_sales_daily/{YYYY-MM-DD}` に `inquiries / surveys / estimates / orders` の日別件数だけを上書き同期する。同期は同じ日を置換するため冪等。個人情報は送らない。

## 指標定義

- `visitors`: 同じブラウザを同じJST日内で1回と数える匿名訪問者
- `pageViews`: HTMLページの表示回数
- `lineClicks`: `line.me` CTAクリック
- `phoneClicks`: `tel:` CTAタップ
- `inquirySubmits`: `submitForm` / `submitOtherInquiry` のFirestore保存成功
- `lineFollows` / `lineUnfollows`: 署名検証済みLINE webhookのfollow / unfollow
- `inquiries`: 営業OS `受付日`。状態が取消・重複の行は除外
- `surveys`: 営業OS `現調実施日`
- `estimates`: 営業OS `見積提出日`
- `orders`: 営業OS `成約日`

欠損日は0、欠損日付は未計上とし、推測で補完しない。LINEの `followers` は累計友だち追加、`blocks` は基準日時点のブロック数であり、正確な現在友だち数ではないため差し引き推測を表示しない。

## Secret

- 既存: `LINE_ACCESS_TOKEN`, `ADMIN_LINE_USER_ID`
- 追加: `LINE_CHANNEL_SECRET`（LINE webhook署名検証）
- 追加: `FUNNEL_DASHBOARD_TOKEN`（ダッシュボード閲覧・営業OS同期）

いずれもコードへ直書きしない。LINE Channel Secretの発行・再発行や既存Tokenの無効化は行わない。

## Functionsと障害分離

- `logInteraction`: 訪問・LINEクリック・電話タップを保存し日次集計
- `submitForm` / `submitOtherInquiry`: 問い合わせ原本を保存し、集計と管理者LINE通知を後続実行
- `lineWebhook`: LINE署名を検証し、follow / unfollowをevent IDで重複排除
- `syncSalesFunnel`: 営業OSの日別件数をBearer認証で同期
- `getFunnelDashboard`: 認証済み集計API。LINE insight障害時もサイト・営業指標を返す
- `funnelDashboard`: noindexの表示HTML

サイト計測はブラウザ側で例外を握り、計測障害でリンクや表示を止めない。フォームは原本のFirestore保存成功後、集計とLINE通知を別々にfail-soft実行する。LINE送信エラーはHTTP状態・code・短いmessageだけをログへ出し、Authorization、送信本文、顧客情報を出さない。

## テスト計測の除外

全イベントは監査用の総数へ保存し、認証済みテストだけを同じ日次文書の `testMetrics` / `testSources` にも記録する。ダッシュボードは総数からテスト分だけを差し引くため、データを物理削除しない。

- サイト・フォームsmoke: JSONの `test_event: true` と `Authorization: Bearer <FUNNEL_DASHBOARD_TOKEN>` の両方が必要。フラグだけなら実イベントとして扱い、通常ユーザーを誤除外しない。
- LINE smoke: 正常なChannel署名を必須とし、`webhookEventId` が `smoke_` で始まる合成イベントだけをテスト扱いにする。
- 2026-08-29 JSTの初回本番smokeは、既知の件数と `production_smoke` / `codex_browser_smoke` だけを集計時に除外する。原本と日次総数は変更しない。

本番ブラウザsmokeでは、テストランナーが送信リクエストへ上記フラグと認証ヘッダーを付ける。公開URLの `from` だけを除外条件にしてはならない。

## LINE送信ルール

問い合わせ通知と本番接続smokeは、管理者1名宛ての `push` だけを使う。`broadcast`、`multicast`、`narrowcast` は本番テスト・運用コードとも禁止。LINE送信先URLは `functions/lib/line.js` のpush専用定数から変更せず、全関連テストの禁止エンドポイント検査を通す。

## 本番接続

1. Functionsをデプロイする。
2. LINE Developers ConsoleのWebhook URLを `https://us-central1-aokitosou-miniapp.cloudfunctions.net/lineWebhook` に設定し、検証する。
3. 営業OS Apps Scriptへ `integrations/sales-os/FunnelMetricsAdapter.gs` を追加し、Script Propertiesの `FUNNEL_DASHBOARD_TOKEN` にFirebase側と同じ値を設定する。
4. `aokiFunnelPreviewSalesMetrics()` で日別件数を確認後、`aokiFunnelSyncSalesMetrics()` を実行する。
5. `funnelDashboard` URLを開き、閲覧トークンを入力する。トークンはブラウザのsessionStorageだけに保持する。

本番接続前は営業OS正本を変更しない。営業OS側へ反映する直前に現行ソースと本番スナップショットを再取得し、他AIの変更と競合しないことを確認する。

## Deploy / smoke / rollback

1. `main` と `origin/main`、作業ツリー、Functions一覧、Secretの版と有効状態を確認する。Secret値は表示しない。
2. 認証・Functions変更はtestブランチへ退避してpushし、`cd functions; npm test`、`npm audit --omit=dev`、`git diff --check` を通す。
3. 差分と影響範囲を説明し、リポジトリ運用ルールに従って本番deploy承認を得る。
4. `firebase deploy --only functions` 後、公開サイトPC/モバイル、フォームvalidation、署名正常/不正、重複Webhook、認証API、ダッシュボードをsmokeする。実送信が必要な場合も管理者宛てpush 1件までとする。
5. Functionsログに例外、異常再試行、LINE/集計失敗、Secret・PII露出がないことを確認する。

ロールバックは本番直前commitを記録し、そのcommitのFunctionsを再deployする。Firestoreのイベント原本や日次総数は削除・一括補正しない。テスト除外に問題がある場合はコードを戻して再集計し、データ破壊を避ける。
