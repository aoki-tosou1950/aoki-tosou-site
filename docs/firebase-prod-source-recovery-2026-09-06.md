# Firebase本番Functions正本復旧記録（2026-09-06）

## 復旧理由

2026-08-31に本番`aokitosou-miniapp`プロジェクトへデプロイされた4つのCloud Functions（`logInteraction`の更新差分、および`getFunnelDrilldown`／`getFunnelInsights`／`getFunnelRecentActivity`の新規実装）が、このリポジトリのどのブランチ・どのコミットにも一切記録されていないことが、READ ONLY監査（本番Cloud Functions/Cloud Run棚卸し、実際にダウンロードした本番immutable sourceとのSHA-256比較、全ブランチのgit履歴検索）で確定した。本番では現在も正常に稼働しており、機能改修や設計変更は一切行っていない。**本番で既に2026-08-31から稼働しているソースコードを、Git管理下へそのまま復旧するだけの作業。**

本復旧作業ではPRODUCTIONへのdeploy・設定変更・Secret変更・IAM変更・Firestore書込みを一切行っていない。

## 4関数の本番revision・deploy日時・Cloud Build ID

| Function | Cloud Runサービス名 | 本番revision | ソースアップロード時刻（UTC） |
|---|---|---|---|
| `logInteraction` | `loginteraction` | `loginteraction-00007-col` | 2026-08-31T01:41:41.092Z |
| `getFunnelDrilldown` | `getfunneldrilldown` | `getfunneldrilldown-00003-jad` | 2026-08-31T01:41:41.010Z |
| `getFunnelInsights` | `getfunnelinsights` | `getfunnelinsights-00001-qes` | 2026-08-31T01:40:54.771Z |
| `getFunnelRecentActivity` | `getfunnelrecentactivity` | `getfunnelrecentactivity-00001-zet` | 2026-08-31T01:41:40.370Z |

4関数とも同一のCloud Build（build-name: `projects/546067044990/locations/us-central1/builds/6664579b-ff1a-4179-8bce-0fbc4c5d3d21`）から、同一の`firebase deploy`操作で一括デプロイされたことを、`gcloud run services describe`のbuild-image-uri・build-nameアノテーションの一致で確認済み。

（参考：比較対象として、現在も本番で稼働中の`getFunnelDashboard`（`getfunneldashboard-00004-xew`）・`lineWebhook`（`linewebhook-00004-diy`）は、別の2026-08-30T00:17:47Z台のCloud Build（build-name: `e755bf8a-96e0-4b58-b4d5-73de2025df53`）からのデプロイであり、今回復旧するバッチとは完全に別のデプロイ操作。）

## 本番ソースSHA-256

`gcloud storage cp`で、本番のimmutable source（`gs://gcf-v2-sources-546067044990-us-central1/logInteraction/function-source.zip`ほか）を、既存リポジトリ外の一時ディレクトリへ取得し、展開したファイルのSHA-256を記録した。

| ファイル | SHA-256 |
|---|---|
| `functions/index.js` | `7b0b114dcacce5130aa69bd9a4c3a1a1d441c370d48e2e40dbc57d23354fd658` |
| `functions/lib/funnel.js` | `fbae085c6dfe5463e1a97a999a0d0c71608d376ee7ddf130d6ac0e1cb3c858b9` |
| `functions/dashboard.html`（無変更） | `5b06d54e44d46f3291362599c1f2a2eb45a1aac426b4b19607d96c28f95d1fb1` |
| `functions/lib/line.js`（無変更） | `e44136c9dc50abd141f3e3c7b2a4eb8da10e418a54e86891643ead51745734f1` |
| `functions/package.json`（無変更） | `761dc53f55651dcceb179c117701b2174fc6ff7b00873eed67badcffa39c136f` |
| `functions/package-lock.json`（無変更） | `85f923fd0a6a4e386f56ee0955d8e60bbba3d840505498764174b88d3a86bdf8` |

本コミット後の`functions/index.js`・`functions/lib/funnel.js`は、上記本番ソースのSHA-256と完全一致することを確認済み（バイト単位で同一）。

## 復旧したファイル

- `functions/index.js`
- `functions/lib/funnel.js`

（`functions/dashboard.html`・`functions/lib/line.js`・`functions/package.json`・`functions/package-lock.json`は本番バッチBと現行`main`とで完全一致していたため、変更していない。本番のバッチBには`functions/test/`が含まれていなかった＝2026-08-31のデプロイはtestディレクトリを含まないソースから行われたと考えられる。既存の`functions/test/`配下のテストファイルは`main`のものをそのまま維持している。）

## バッチAとの比較結果

現在`main`ブランチに存在する内容（＝2026-08-30T00:17:47Z台のバッチAデプロイと完全一致することを別途確認済み）を基準に、本番バッチBとの差分を精査した。

- `functions/dashboard.html`／`functions/lib/line.js`／`functions/package.json`／`functions/package-lock.json`：**完全一致（差分ゼロ）**。
- `functions/index.js`：**720行中106行の差分。すべて追加（純粋追加）**。既存の`submitForm`・`submitOtherInquiry`・`lineWebhook`・`syncSalesFunnel`・`getFunnelDashboard`・`funnelDashboard`の各関数定義本体には**1行の変更もない**（diffで直接確認済み）。変更点は次の3つのみ：
  1. `require('./lib/funnel')`の分割代入へ`funnelDrilldown`・`funnelInsights`・`funnelRecentActivity`・`visitorToken`を追加（インポート追加のみ）。
  2. `logInteraction`内の`interaction_logs.add()`へ`from: event.from`・`visitor_hash: ...`の2行を追加。
  3. ファイル末尾へ`exports.getFunnelDrilldown`／`exports.getFunnelInsights`／`exports.getFunnelRecentActivity`の3関数を新規追加。
- `functions/lib/funnel.js`：**616行の差分。すべて追加（純粋追加）**。既存の`normalizeEvent`・`aggregateRows`・`dashboardPayload`・`createFunnelStore`（`recordWebEvent`・`recordInternalMetric`・`recordLineEvent`）等、バッチA由来の全既存関数の本体には**1行の変更もない**。`normalizeEvent`に`from`フィールドの読み取りが1行追加された以外は、すべて新規関数・新規定数の追加（`humanizeSource_`・`humanizeReferrer_`・`computeLeadScore_`・`funnelDrilldown`・`funnelInsights`・`funnelRecentActivity`等）。`module.exports`の変更も、既存エクスポート名の削除は無く、新規エクスポート名の追加のみ（`LEGACY_TEST_EXCLUSIONS`・`funnelDrilldown`・`funnelInsights`・`funnelRecentActivity`・`visitorToken`）。
- **結論：現在本番で稼働中の`lineWebhook`・`getFunnelDashboard`・`submitForm`等（バッチA）を後退させる差分は一切無い。** 純粋な機能追加のみであり、既存関数への意図しない変更・削除は診断上ゼロ件。

## 本番変更・deployを行っていないことの確認

本復旧作業を通じて、`aokitosou-miniapp`プロジェクトへの`deploy`・Secret変更・IAM変更・Firestore書込み・Script Properties相当の設定変更は一切実行していない。実行したのは以下のREAD ONLY操作のみ：`gcloud functions list`／`gcloud run services list`／`gcloud run services describe`／`gcloud storage cp`（immutable sourceの取得）／`gcloud logging read`。ローカルgit worktree・ブランチへの変更のみを行った。

## 今後の注意事項（恒久ルール）

**今後、`aokitosou-miniapp`のFunctionsを一括で`firebase deploy`する前には、必ず本ドキュメントの内容（バッチA＝2026-08-30デプロイとバッチB＝2026-08-31デプロイという、2つの異なるソース状態が個別の関数ごとに本番稼働している事実）を踏まえ、`main`ブランチの内容が実際の本番稼働状態（全10関数分）と一致しているかを、本ドキュメントと同じ手法（`gcloud run services describe`のrevision・build-image-uri比較、可能なら`gcloud storage cp`によるimmutable source取得とSHA-256比較）で機械的に再確認すること。** `git log`上のコミット履歴だけを正本とみなさない（今回、正本コード約1,000行がコミット0件のまま本番稼働していた事実が実証されたため）。

`main`への`merge`、本番への`deploy`は本ドキュメント作成時点では未実施。取締役の別途明示指示を待つ。
