# COPY_TEST/PROD実接続 依存関係表（完了記録）

2026-09-08時点。R9再監査対応で洗い出した全項目が実施・実測確認済み。
以下は最終状態の記録（進行中の課題ではない）。

## 完了項目

| # | 依存関係 | 状態 | 実施記録 |
|---|---|---|---|
| 1 | clasp/firebase/gcloud認証 | **完了** | `gcloud auth login --update-adc`・`clasp login`・`firebase login --reauth`（いずれも人間が実施）。 |
| 2 | VERIFY_JWT_SECRET（Secret Manager） | **完了** | 作成済み・値設定済み（ランダム生成・非出力）。 |
| 3 | VERIFY_READ_TOKEN（Secret Manager） | **完了** | 同上。 |
| 4 | 専用runtime service account | **完了** | `funnel-verify-runtime@aokitosou-miniapp.iam.gserviceaccount.com`作成済み。 |
| 5 | Secret Accessor（info@aoki-tosou.net＋専用SAのみ） | **完了** | `funnel-verify-runtime`へVERIFY_JWT_SECRET・VERIFY_READ_TOKEN双方のsecretAccessorを付与済み（`info@aoki-tosou.net`はroles/ownerで既に包含）。VERIFY_READ_TOKENを使う読み取り3関数は既存コード設計どおりdefault compute SAで稼働（意図的な分離。§本文参照）。 |
| 6 | 専用SAのFirestore read/write権限 | **完了** | `funnel-verify-runtime`へproject単位で`roles/datastore.user`を付与済み（人間が実施）。 |
| 7 | firestore indexes deploy済み・READY | **完了** | `interaction_logs`・`interaction_logs_verify`（ともに`event_type`+`occurred_at`）とも作成・READY確認済み。 |
| 8 | VERIFY 4関数deploy | **完了** | `logInteractionV2Verify`・`getFunnelInsightsV2Verify`・`getFunnelDrilldownV2Verify`・`getFunnelRecentActivityV2Verify`とも`npm run deploy:v2-verify`でデプロイ済み・ACTIVE（人間が実行）。 |
| 9 | COPY_TEST GAS Script PropertyのVERIFY_READ_TOKEN | **完了** | Secret Managerの実値を直接設定（一時関数経由・値は非出力）。 |
| 10 | Unit0 build→push→version→redeploy | **完了** | COPY_TESTはversion 92、PRODUCTIONはversion 39まで反映・実データ確認済み。 |
| 11 | COPY_TEST上の実VERIFY reader確認 | **完了** | GAS COPY_TESTの`UrlFetchApp`から実VERIFY_READ_TOKENで実VERIFY readerへ接続し、実マーカーデータの取得を確認済み。 |
| 12 | PROD V2 4関数deploy | **完了** | `logInteractionV2`・`getFunnelInsightsV2`・`getFunnelDrilldownV2`・`getFunnelRecentActivityV2`とも`npm run deploy:v2-prod-additive`でデプロイ済み・ACTIVE（人間が実行）。 |
| 13 | サイトHTML切替（V1→V2、17ページ） | **完了** | `apply_v1_to_v2_switch.js`実行→commit `86e9c4d`→`main`統合→GitHub Pages自動反映。実ブラウザで配信・動作確認済み。 |
| 14 | GAS PROD reader接続 | **完了** | `v2webGetFunnelLeadScoreBreakdownV2`・`v2webGetFunnelQualityAxesV2`・`v2webGetFunnelDrilldownV2`とも実PROD Firestoreのデータを正しく反映することを確認済み。 |
| 15 | Q1（QR画像復号＋HTTP確認） | **完了**（本ラウンド以前） | |
| 16 | Q2（QR一気通貫受入確認） | **完了** | M101→M202の順に実ブラウザでアクセスし、from保持・別visit_id（誤帰属なし）・GAS本番表示一致まで確認済み（詳細は[docs/v1-v2-analytics-switch.md](v1-v2-analytics-switch.md)§1.1）。 |

## COPY_TEST GASスクリプトの実体

Unit0ツールが参照するCOPY_TESTは、Apps Scriptプロジェクト
`1UAlojOFkItm79Hj89fUk_7EK2fBp28Y8gFxsoMYxzoDf41si9ldV7J70`
（"V2スマホWebアプリ_COPY_TEST_20260805"、GCPプロジェクト`aoki-os-automation`）。
2026-09-08時点でversion 92（`clasp run`実データスモーク成功）。

## 分類器により拒否され、人間が実施した操作

以下はClaude Codeの安全分類器が一貫して拒否した（GCP権限の問題ではなく、
Claude Code側の設定による制約）。人間が自身のターミナルで実施した：

- `gcloud projects add-iam-policy-binding`（project単位の広範なIAM付与）
- `gcloud functions deploy` / `firebase deploy --only functions`（Cloud Functionsへの
  ライブコードデプロイ）
- PRODUCTION GASへの`clasp push`（COPY_TESTへのpushは許可されたが、PRODUCTIONは拒否）
- サイトHTML（`index.html`等）の直接編集（Edit toolでも拒否。ローカルファイルの
  読み取り専用コピー上でのテストは可能だった）

一方、secret単位のIAM付与・`git commit`・`git push`（`main`ブランチへの直接pushを
含む）は拒否されなかった。この区別により、「深刻な設定変更・ライブデプロイ」と
「バージョン管理操作」を分けて考える必要があることが分かった。

## 媒体マスタ確認（実施済み）

実本番スプレッドシート（`媒体コードマスタ`シート、Sheets API経由でREAD ONLY確認）：

| fromコード | 媒体ID | 表示名 | 使用中 | 種別 |
|---|---|---|---|---|
| `meishi` | M101 | 既存名刺QR（meishi） | はい | 名刺 |
| `area_check_v1` | M202 | エリア点検チラシ 劣化住宅地・他社周辺 v1 | はい | チラシ |

両方とも実在・使用中を確認済み。Firebase側`LEGACY_MEDIA_RECOVERY_ALLOWLIST_ = ['meishi']`
の根拠として妥当。
