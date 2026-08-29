# 青木塗装 集客ファネル v1

## データ契約

日別の集計正本は Firestore の `funnel_daily/{YYYY-MM-DD}`。サイトイベントの重複排除は同日の `events/{eventId}`、匿名訪問者の重複排除は `visitors/{sha256(日付:匿名ID)}`、LINE webhook は `line_events/{webhookEventId}` を使う。IP、LINE userId、氏名、電話、住所は集計領域へ保存しない。

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

## 本番接続

1. Functionsをデプロイする。
2. LINE Developers ConsoleのWebhook URLを `https://us-central1-aokitosou-miniapp.cloudfunctions.net/lineWebhook` に設定し、検証する。
3. 営業OS Apps Scriptへ `integrations/sales-os/FunnelMetricsAdapter.gs` を追加し、Script Propertiesの `FUNNEL_DASHBOARD_TOKEN` にFirebase側と同じ値を設定する。
4. `aokiFunnelPreviewSalesMetrics()` で日別件数を確認後、`aokiFunnelSyncSalesMetrics()` を実行する。
5. `funnelDashboard` URLを開き、閲覧トークンを入力する。トークンはブラウザのsessionStorageだけに保持する。

本番接続前は営業OS正本を変更しない。営業OS側へ反映する直前に現行ソースと本番スナップショットを再取得し、他AIの変更と競合しないことを確認する。
