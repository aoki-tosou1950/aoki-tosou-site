# COPY_TEST実接続 依存関係 ready/not-ready 表（独立監査再提出R9再監査対応）

2026-09-08時点の実測（gcloud/clasp認証は本ラウンド中に復旧し、以下はすべて
**実際にコマンドを実行して得られた結果**。「関数が未deployだからindexも
未作成のはず」という推測では出していない）。書込み系操作（Secret作成・IAM
バインディング・service account作成・indexデプロイ・関数デプロイ・
COPY_TEST push）は本ラウンドでは一切実施していない（READ ONLYのみ）。

## 認証状態（本ラウンド中に復旧）

`gcloud auth login --update-adc --account=info@aoki-tosou.net` と `clasp login`
を実施し、以下を実測確認した：
- `gcloud auth print-access-token` 成功
- `gcloud auth application-default print-access-token` 成功
- `clasp list` 成功（15スクリプトを取得）

以後の各項目は、この復旧した認証を使って実際にgcloud/firebase CLIで確認した結果。

## ready/not-ready 表

| # | 依存関係 | 状態 | 根拠（実測） |
|---|---|---|---|
| 1 | clasp/firebase/gcloud認証 | **READY**（本ラウンド中に復旧） | 上記のとおり3つとも実際に成功を確認済み。 |
| 2 | VERIFY_JWT_SECRET（Secret Manager） | **NOT READY（未作成）** | `gcloud secrets list --project=aokitosou-miniapp`の実測結果：`ADMIN_LINE_USER_ID`・`FUNNEL_DASHBOARD_TOKEN`・`LINE_ACCESS_TOKEN`・`LINE_CHANNEL_SECRET`の4件のみが実在し、`VERIFY_JWT_SECRET`という名前のSecretは存在しない（"unknown"ではなく、確認の結果「無い」ことが判明）。 |
| 3 | VERIFY_READ_TOKEN（Secret Manager） | **NOT READY（未作成）** | 同上（#2と同じ実測結果。この名前のSecretも存在しない）。 |
| 4 | 専用runtime service account | **NOT READY（未作成）** | `gcloud iam service-accounts list --project=aokitosou-miniapp`の実測結果：`aokitosou-miniapp@appspot.gserviceaccount.com`（App Engineデフォルト）・`firebase-adminsdk-fbsvc@aokitosou-miniapp.iam.gserviceaccount.com`・`546067044990-compute@developer.gserviceaccount.com`（Compute Engineデフォルト）の3件のみが実在し、コード側が前提とする`funnel-verify-runtime@aokitosou-miniapp.iam.gserviceaccount.com`は存在しない。 |
| 5 | Secret Accessor（info@aoki-tosou.net＋専用SAのみ） | **人間分＝実質READY（Owner権限で包含）。専用SA分＝NOT READY（#4が無いため付与しようがない）** | `gcloud projects get-iam-policy aokitosou-miniapp`の実測結果：`info@aoki-tosou.net`は`roles/owner`を保持している（Owner権限はSecret Accessorを含む全操作を包含するため、人間側の権限は技術的には既に足りている）。専用SA分は#4のSA自体が存在しないため、付与対象が無い。 |
| 6 | 専用SAのFirestore read/write権限 | **NOT READY（#4と同じ理由）** | 同上。 |
| 7 | firestore indexes deploy済み・READY | **NOT READY（実測。推測ではない）** | `gcloud firestore indexes composite list --project=aokitosou-miniapp`の実測結果：実在するcomposite indexは1件のみ（`interaction_logs`・フィールド`event_type`+`created_at`・STATE=READY）。これは`firestore.indexes.json`が要求する`event_type`+`occurred_at`（`interaction_logs`・`interaction_logs_verify`の両方）とは**別のフィールド組み合わせ**であり、V2/VERIFY用の想定indexは存在しない。`interaction_logs_verify`コレクションにはindexが1件も無い。 |
| 8 | VERIFY 4関数deploy | **NOT READY（実測）** | `gcloud functions list --project=aokitosou-miniapp`の実測結果：デプロイ済みは`funnelDashboard`・`getFunnelDashboard`・`getFunnelDrilldown`・`getFunnelInsights`・`getFunnelRecentActivity`・`lineWebhook`・`logInteraction`・`submitForm`・`submitOtherInquiry`・`syncSalesFunnel`の10関数（すべてV1・ACTIVE）のみ。V2系8関数（VERIFY専用4関数を含む）はいずれも未デプロイ。 |
| 9 | COPY_TEST GAS Script PropertyのVERIFY_READ_TOKEN | **NOT READY（未確認・確認手段が無い）** | `clasp run`でScript Propertiesを読む既存の読み取り専用関数がCOPY_TEST側に存在しないため、新規関数をpush（禁止）せずに安全にREAD ONLY確認する手段が現時点で無い。#3のとおりVERIFY_READ_TOKEN自体もまだ存在しないため、設定すべき値も未確定。 |
| 10 | Unit0 build→push→version→redeploy | **ローカルbuildパイプラインはREADY・実push未実施** | clasp認証復旧後、`node gas_v2/ops/build_copy_test_staging.js`を実行し、R9反映後のcanonicalから実際に`clasp pull`（読み取り専用）→ローカルCOPY_TEST staging生成までを完走（BLOCK 0件・R9の`legacy_opaque`修正が変換後stagingへ実在することを確認済み）。ただし`clasp push`/`create-version`/`redeploy`は本ラウンドでは実施していない（このスクリプト自体もpush/deploy/redeployを呼び出さない設計）。 |
| 11 | COPY_TEST上の実VERIFY reader確認 | **NOT READY**（#2・#3・#8が未整備のため対象自体が存在しない） | 上記の帰結。 |

## 「書けるのに書かない」ものについての明示

`info@aoki-tosou.net`はGCPプロジェクト上で`roles/owner`を保持しており、技術的には
Secret作成・service account作成・IAMバインディング・Firestore indexデプロイ・
Cloud Functionsデプロイのいずれも、今のgcloud認証で実行可能な状態にある
（＝GCP側が拒否するわけではない）。それでも本ラウンドでこれらを実施していない
理由は、GCPの権限不足ではなく、**このタスクに課された禁止事項**
（「COPY_TEST/PRODへのpush・deploy、Secret/IAM変更、本番データ書込み...は行わない」）
に基づく方針判断である。この区別を明確にする：「環境が拒否している」のではなく、
「実行可能だが、本ラウンドのスコープ外として意図的に実施していない」。

## COPY_TEST GASスクリプトの実体（本ラウンドで確認・訂正）

Unit0ツール（`gas_v2/ops/build_copy_test_staging.js`・`known_environments.json`）が
参照するCOPY_TESTは、Apps Scriptプロジェクト`1UAlojOFkItm79Hj89fUk_7EK2fBp28Y8gFxsoMYxzoDf41si9ldV7J70`
（"V2スマホWebアプリ_COPY_TEST_20260805"、GCPプロジェクト`aoki-os-automation`、
現行deployedVersion=91）である。`clasp list`で実在する15スクリプトを確認したところ、
類似名の別スクリプト（`1gb0yc9goMfjg_Jluv32lKlqUxgjXcFc636BtgMx5jmONjFAtRVCcY5g3`等）も
複数存在するが、Unit0ツールが実際に参照・pull・buildするのは上記の1件だけである
（`CANONICAL_SOURCE.json`→`known_environments.json`の参照チェーンで一意に特定済み）。

## PROD切替の最終手順に含める追加ステップ（取締役確定・本ラウンドで追記）

実際のPROD切替（V1→V2）を行う際は、以下も手順に含める（`docs/v1-v2-analytics-switch.md`
§1.1に詳細を記載）：

- **GAS reader反映**：COPY_TEST／PRODUCTION双方のGAS Script Propertyへ
  `VERIFY_READ_TOKEN`（または本番運用ではPROD向けの`FUNNEL_DASHBOARD_TOKEN`相当）を
  設定し、GAS側が実際にV2 readerへ接続できることを確認する。
- **媒体マスタ確認**：R9項目5で導入した`LEGACY_MEDIA_RECOVERY_ALLOWLIST_ = ['meishi']`
  （Firebase側の保守的なプレースホルダ）を、GAS側の実媒体コードマスタ
  （`媒体コードマスタ`シート）と突き合わせ、復元してよい媒体コードの一覧が
  実態と一致しているか確認する。
- **Q1／Q2（QR実機受入確認）**：`docs/v1-v2-analytics-switch.md`§1.1のとおり。
  Q1（QR画像復号＋HTTP確認）は完了済み。Q2（M101→M202の実機QR一気通貫確認）は
  PROD切替後に実施する（本ラウンドでは未実施。実機操作が必要な時点で人間へ
  1操作ずつ案内する）。
