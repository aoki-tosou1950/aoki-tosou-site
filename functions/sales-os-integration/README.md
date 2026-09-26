# 営業OSの参考値表示・Google Cloud版 Gemini

funnel-ai-reference.patch は clasp pull で取得した 2026-09-26 時点の営業OS現行ソースに対する差分。未公開。保存元の一時スナップショット二つは GitHub に含めない。パッチは同じ現行ソースに対して git apply --check を通過した。

フォームの分類は aokitosou-miniapp の Vertex AI (Gemini Enterprise Agent Platform) で gemini-3.5-flash を使用。Cloud Functions の実行アカウントが ADC/OAuth で呼び出し、API キーと OpenAI Secret は不要。分類トリガー classifyFormAi だけに専用アカウント form-ai-runtime@aokitosou-miniapp.iam.gserviceaccount.com を設定する。元のフォーム保存と LINE 通知は従来のまま。AI に送るのは媒体、フォーム種別、工事種別、文字欄のみで、氏名・住所・電話番号の列は渡さない。

公開前の条件: aokitosou-miniapp で aiplatform.googleapis.com を有効化し、専用実行アカウントを作成して roles/aiplatform.user と roles/datastore.user を付与する。デプロイ権限に当該アカウントの iam.serviceAccounts.actAs が必要。Firebase の API キーは作らない。今は API が無効・アカウントが未作成のため、実 API での試行および本番公開は行わない。バックオフィス OS は Apps Script Script Properties の GEMINI_API_KEY を用いる別経路で、そのキーの Google Cloud プロジェクトと請求先は未確認。

ユーザー入力の Google 側での扱い: Vertex AI では事前許可なくモデル学習には使用しない。既定のインメモリキャッシュは最大 24 時間。通常のリクエスト・レスポンスログは既定で無効。疑わしい要求の監視ログは最大 90 日保持されうる。ゼロ保持が必要な場合は Google Cloud の例外申請とキャッシュ設定を別途確認する。AI Studio の無償 Gemini API と混同しないこと。

API 有効化・権限付与後に read-only の scripts/ai_form_history_trial.js で既存記録を再判定し、分類精度を確かめる。テストデータとテストフラグのある過去記録は除外し、既存記録の書き換えや LINE 送信は行わない。営業 OS の Apps Script は現行ソースにこのパッチを適用し、テストの後に別途公開する。main と本番へは未反映。

戻し方: 元の Apps Script ソース／デプロイ版へ戻し、サイト関数は本作業前の 89197b2（A 反映済み）から該当関数のみ再公開する。AI 分類トリガーを止める。フォーム記録・通知済みメッセージ・過去の判定記録は消さない。