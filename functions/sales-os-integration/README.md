# 営業OSの参考値表示

`funnel-ai-reference.patch` は、2026-08-30 の保存版 Apps Script の `V2MobileWebApp.js` と `V2MobileApp.html` に対する差分です。保存元の二つの一時スナップショット自体は GitHub に含めません。

営業OS本体はこの GitHub リポジトリとは別の Apps Script です。現在の本番版に差分を入れる前に、認証を回復して `clasp pull` で最新版を別ディレクトリに取得し、変更箇所との衝突がないか確認してください。差分は保存版への `git apply --check` を通過しています。`clasp push` / デプロイはこの作業ではしていません。

公開準備: OpenAI API キーを Secret Manager の `OPENAI_API_KEY` に安全に登録し、フォーム関数とは独立した分類トリガーにだけ権限を与える。媒体名サービスを読み取り専用の専用アカウントで非公開 Cloud Run に出し、フォーム関数の実行アカウントに invoker のみを付ける。フォーム関数に `MEDIA_LABELS_URL` を設定する。営業OS最新版を確認して差分を当て、限定した関数と画面だけを公開する。過去記録の試行は `node scripts/ai_form_history_trial.js` を使用し、環境変数経由の API キーが未設定なら実行しない。過去記録は書き換えない。

戻し方: 先に取得した現行の Apps Script ソース／デプロイ版へ戻し、サイト関数は本作業前の `89197b2`（A反映済み）から該当関数のみ再公開する。AI分類トリガーを止める。フォーム記録・通知済みメッセージ・過去の判定記録は消さない。