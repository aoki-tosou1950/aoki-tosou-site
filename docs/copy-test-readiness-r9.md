# COPY_TEST実接続 依存関係 ready/not-ready 表（独立監査再提出R9・項目6）

2026-09-07時点、実環境への実操作（push/deploy等）は一切行わず、READ ONLYで確認できた
事実だけを記載する。「clasp再認証だけ」という単純化はしない。

| # | 依存関係 | 状態 | 根拠・詳細 |
|---|---|---|---|
| 1 | clasp/firebase/gcloud認証 | **NOT READY**（一部READY） | `clasp list`・`gcloud auth print-access-token`・`gcloud auth application-default print-access-token`・firebase-admin ADC接続はすべて同一エラー`invalid_grant: reauth related error (invalid_rapt)`で失敗（人間の対話的再ログインが必要。プログラムで解決不可）。一方、`firebase functions:list --project aokitosou-miniapp`は成功する（Firebase CLI独自のトークンキャッシュがgcloud/clasp/ADCとは別に有効なため）。→ **clasp・gcloud・ADCの3つは要再ログイン。firebase CLIのみ現在有効**。 |
| 2 | VERIFY_JWT_SECRET（Secret Manager） | **UNKNOWN（未確認）** | `gcloud secrets list --project=aokitosou-miniapp`が#1と同じ認証エラーで失敗するため、実在有無を確認できない。コード側（`functions/index.js`のsecrets配列）は`VERIFY_JWT_SECRET`という名前でSecret Managerから取得する前提で実装済み。 |
| 3 | VERIFY_READ_TOKEN（Secret Manager） | **UNKNOWN（未確認）** | 同上（#2と同じ理由で確認不可）。コード側は`VERIFY_READ_TOKEN`という名前を前提に実装済み。 |
| 4 | 専用runtime service account | **UNKNOWN（未確認）** | コード上は`funnel-verify-runtime@aokitosou-miniapp.iam.gserviceaccount.com`という名前が`functions/index.js`の`VERIFY_RUNTIME_SERVICE_ACCOUNT`定数として存在するが、このSAが実際にGCPプロジェクト上に作成済みかどうかは`gcloud iam service-accounts list`等が実行できず確認不可。 |
| 5 | Secret Accessor（info@aoki-tosou.net＋専用SAのみ） | **UNKNOWN（未確認）** | `gcloud projects get-iam-policy aokitosou-miniapp`が#1と同じ理由で失敗するため、実際のIAMバインディング（誰がSecret Accessorロールを持つか）を確認できない。 |
| 6 | 専用SAのFirestore read/write権限 | **UNKNOWN（未確認）** | 同上（#5と同じ理由でIAM確認不可）。 |
| 7 | firestore indexes deploy済み・READY | **NOT READY** | `firestore.indexes.json`はcomposite index定義2件（`interaction_logs`・`interaction_logs_verify`、いずれも`event_type`+`occurred_at`）をローカルに持つが、`gcloud firestore indexes composite list`が実行できず実Firestore側の状態を直接確認できない。ただし#8（実デプロイ済み関数一覧）で判明したとおり、V2系機能は一切本番デプロイされていないため、対応するインデックスも作成されていないと判断するのが安全側（実際にREADYであるという確認が取れない限りNOT READY扱いとする）。 |
| 8 | VERIFY 4関数deploy | **NOT READY** | `firebase functions:list --project aokitosou-miniapp`の実測結果：現在デプロイ済みなのは`funnelDashboard`・`getFunnelDashboard`・`getFunnelDrilldown`・`getFunnelInsights`・`getFunnelRecentActivity`・`lineWebhook`・`logInteraction`・`submitForm`・`submitOtherInquiry`・`syncSalesFunnel`の10関数（すべてV1）のみ。V2系8関数（`logInteractionV2`・`logInteractionV2Verify`・`getFunnelInsightsV2`・`getFunnelInsightsV2Verify`・`getFunnelDrilldownV2`・`getFunnelDrilldownV2Verify`・`getFunnelRecentActivityV2`・`getFunnelRecentActivityV2Verify`）はいずれも未デプロイ。VERIFY専用4関数（`logInteractionV2Verify`・`getFunnelInsightsV2Verify`・`getFunnelDrilldownV2Verify`・`getFunnelRecentActivityV2Verify`）もこれに含まれ、すべて未デプロイ。 |
| 9 | COPY_TEST GAS Script PropertyのVERIFY_READ_TOKEN | **NOT READY** | clasp認証が#1のとおり無効なため、COPY_TEST側Script Propertiesの実際の設定状態を確認できない。かつ#3のとおりVERIFY_READ_TOKEN自体の実在も未確認であるため、設定するべき値も現時点では確定できない。 |
| 10 | Unit0 build→push→version→redeploy | **NOT READY** | clasp認証が無効（#1）のため、`clasp push`・`clasp create-version`・`clasp redeploy`のいずれも実行不可。本ラウンドではUnit0のCOPY_TEST変換ロジック自体のテスト（`test_unit0_copytest_transform_20260907.js`）は実行・再確認済み（25/25 PASS）だが、これは変換ロジックの正しさの確認であり、実際にCOPY_TESTへpushする作業そのものではない。 |
| 11 | COPY_TEST上の実VERIFY reader確認 | **NOT READY** | #1〜#10がいずれもNOT READYまたはUNKNOWNである以上、実際にCOPY_TEST上でVERIFY readerへ接続して確認する作業には進めない。 |

## まとめ

現時点でREADYと確認できたのは**Firebase CLIの認証のみ**（`firebase functions:list`が
実際に成功し、現在の本番デプロイ状態を読み取れることで確認済み）。

**clasp・gcloud・Application Default Credentialsの3つはいずれも`invalid_rapt`エラーで
無効**であり、これが#2〜#6・#9・#10のUNKNOWN/NOT READY判定の直接の原因になっている
（Secret Manager・IAM・clasp pushのいずれも、この認証切れが解消されない限り一切確認・
実行できない）。

#7・#8（firestore indexes・VERIFY関数デプロイ）は、認証状態に関わらずFirebase CLI
経由で確認可能であり、**実際に確認した結果として明確にNOT READY**（V2系機能は
一切本番へデプロイされていない）。
