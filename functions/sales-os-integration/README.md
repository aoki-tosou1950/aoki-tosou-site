# 営業OSの参考値表示・Google Cloud版 Gemini

funnel-ai-reference.patch は clasp pull で取得した 2026-09-26 時点の営業OS現行ソースに対する差分。未公開。保存元の一時スナップショット二つは GitHub に含めない。パッチは同じ現行ソースに対して git apply --check を通過した。

フォームの分類は aokitosou-miniapp の Vertex AI (Gemini Enterprise Agent Platform) で gemini-3.5-flash を使用。Cloud Functions の実行アカウントが ADC/OAuth で呼び出し、API キーと OpenAI Secret は不要。分類トリガー classifyFormAi だけに専用アカウント form-ai-runtime@aokitosou-miniapp.iam.gserviceaccount.com を設定する。元のフォーム保存と LINE 通知は従来のまま。AI に送るのは媒体、フォーム種別、工事種別、文字欄のみで、氏名・住所・電話番号の列は渡さない。

公開前の条件: aokitosou-miniapp で aiplatform.googleapis.com を有効化し、専用実行アカウントを作成して roles/aiplatform.user と roles/datastore.user を付与する。デプロイ権限に当該アカウントの iam.serviceAccounts.actAs が必要。Firebase の API キーは作らない。今は API が無効・アカウントが未作成のため、実 API での試行および本番公開は行わない。バックオフィス OS は Apps Script Script Properties の GEMINI_API_KEY を用いる別経路。API キーは gen-lang-client-0607553351 （aoki-backoffice-ai）の Gemini API に紐づき、2026-09-26 現在は請求未設定の Free Tier。請求先の接続と有料化はまだ行っていない。

ユーザー入力の Google 側での扱い: Vertex AI では事前許可なくモデル学習には使用しない。既定のインメモリキャッシュは最大 24 時間。通常のリクエスト・レスポンスログは既定で無効。疑わしい要求の監視ログは最大 90 日保持されうる。ゼロ保持が必要な場合は Google Cloud の例外申請とキャッシュ設定を別途確認する。AI Studio の無償 Gemini API と混同しないこと。

API 有効化・権限付与後に read-only の scripts/ai_form_history_trial.js で既存記録を再判定し、分類精度を確かめる。テストデータとテストフラグのある過去記録は除外し、既存記録の書き換えや LINE 送信は行わない。営業 OS の Apps Script は現行ソースにこのパッチを適用し、テストの後に別途公開する。main と本番へは未反映。

戻し方: 元の Apps Script ソース／デプロイ版へ戻し、サイト関数は本作業前の 89197b2（A 反映済み）から該当関数のみ再公開する。AI 分類トリガーを止める。フォーム記録・通知済みメッセージ・過去の判定記録は消さない。

費用の安全策（未公開の作業ブランチ）: AI 判定は JST で1日20回まで。Firestore トランザクションで API 呼び出し前に枠を確保し、枠切れ・枠の読み書き失敗時は Gemini を呼ばず「判断がつかない」として記録する。入力本文600文字、工事種別10個各32文字、出力200トークンまで。分類関数は maxInstances=1/concurrency=1、既存の両フォーム関数は maxInstances=5/concurrency=10 とする。保存と LINE 通知を AI の成功に依存させない。これらはデプロイ前には効かない。Google Cloud 側の Vertex API 有効化・実行アカウントと費用上限は未設定。
