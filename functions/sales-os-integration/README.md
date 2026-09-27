# 営業OSの参考値表示・Google Cloud版 Gemini

funnel-ai-reference.patch は clasp pull で取得した 2026-09-26 時点の営業OS現行ソースに対する差分。未公開。保存元の一時スナップショット二つは GitHub に含めない。パッチは同じ現行ソースに対して git apply --check を通過した。

フォームの分類は aokitosou-miniapp の Vertex AI (Gemini Enterprise Agent Platform) で gemini-3.5-flash を使用。Cloud Functions の実行アカウントが ADC/OAuth で呼び出し、API キーと OpenAI Secret は不要。分類トリガー classifyFormAi だけに専用アカウント form-ai-runtime@aokitosou-miniapp.iam.gserviceaccount.com を設定する。元のフォーム保存と LINE 通知は従来のまま。AI に送るのは媒体、フォーム種別、工事種別、文字欄のみで、氏名・住所・電話番号の列は渡さない。

準備状態（2026-09-27）: aiplatform.googleapis.com は有効。専用実行アカウント form-ai-runtime に roles/aiplatform.user と roles/datastore.user を付与し、鍵は作成していない。ユーザーは管理画面で Vertex AI の月480円支出停止型上限を「構成済み」と確認済み。請求先全体の月2,000円・3,000円アラートも設定済み。デプロイ権限には当該アカウントの iam.serviceAccounts.actAs が必要。フォームAIの本番公開は未実施。バックオフィス OS は Apps Script Script Properties の GEMINI_API_KEY を用いる別経路。API キーは gen-lang-client-0607553351 （aoki-backoffice-ai）の Gemini API に紐づき、2026-09-26 現在は請求未設定の Free Tier。請求先の接続と有料化はまだ行っていない。

ユーザー入力の Google 側での扱い: Vertex AI では事前許可なくモデル学習には使用しない。既定のインメモリキャッシュは最大 24 時間。通常のリクエスト・レスポンスログは既定で無効。疑わしい要求の監視ログは最大 90 日保持されうる。ゼロ保持が必要な場合は Google Cloud の例外申請とキャッシュ設定を別途確認する。AI Studio の無償 Gemini API と混同しないこと。

実試行（2026-09-27）: Gemini 3.5 Flash の read-only 判定で架空10件は顧客3・営業4・不明3に合致（最初の試行では曖昧文3件を誤分類したためプロンプトv2へ修正、再試験中の一過性429は再実行で解消）。過去記録5件のうち1件は test_event のない既知のサイト改修テストで unknown、残る4件は営業と判定。実際のお客様の既知の正解例は0件で、偽陰性率は推定できない。記録・LINEを変更していない。公開前には営業OS現行ソースへパッチを当て直して回帰確認する。認証済み test_event: true の本番動作確認は分類記録を作り、当該記録に test_event: true を付けて参考 KPI から除外する。旧来の未区分テストは変更しない。全テストで失敗する V1→V2 切替テスト3件は同じ GitHub main でも再現し、Windows の CRLF とテストの LF 前提が食い違う既存問題。

承認後の限定公開の順番: GitHub main の最新を再取得し、差分・回帰確認後に B ブランチを main へ取り込む。営業OS現行 Apps Script に参考値パッチを当て直して検証する。媒体名の非公開 Cloud Run サービスを読み取り専用アカウントで公開し、フォーム関数の実行アカウントに当該サービスだけの呼出権限を付ける。フォーム2関数・分類ワーカー・参考値取得関数だけを限定公開し、LINE・媒体名の失敗時フォールバック・従来KPIを確認後、営業OSの参考表示を公開する。どの段階でも既存の全件保存・LINE通知を維持する。

戻し方: 営業OSの Apps Script を直前のソース／デプロイ版へ戻す。サイトの変更関数は A 反映済みの 89197b2 から再公開し、新設した分類ワーカーを停止する。非公開の媒体名サービスは参照不能にしても、フォーム通知は内部媒体コードに戻る。GitHub main は公開に対応する内容で revert し、フォーム記録・通知済みメッセージ・過去の判定記録は消さない。

費用の安全策（未公開の作業ブランチ）: AI 判定は JST で1日10回まで。Firestore トランザクションで API 呼び出し前に枠を確保し、枠切れ・枠の読み書き失敗時は Gemini を呼ばず「判断がつかない」として記録する。入力本文600文字、工事種別10個各32文字、出力200トークンまで。分類関数は maxInstances=1/concurrency=1、既存の両フォーム関数は maxInstances=5/concurrency=10 とする。保存と LINE 通知を AI の成功に依存させない。コード側の回数制限はデプロイ前には効かない。Google Cloud 側の API と実行アカウントは設定済み。
