# Firebase本番Functions正本復旧記録（2026-09-06）

## 復旧理由

2026-08-31に本番`aokitosou-miniapp`プロジェクトへデプロイされた4つのCloud Functions（`logInteraction`の更新差分、および`getFunnelDrilldown`／`getFunnelInsights`／`getFunnelRecentActivity`の新規実装）が、このリポジトリのどのブランチ・どのコミットにも一切記録されていないことが、READ ONLY監査（本番Cloud Functions/Cloud Run棚卸し、実際にダウンロードした本番immutable sourceとのSHA-256比較、全ブランチのgit履歴検索）で確定した。本番では現在も正常に稼働しており、機能改修や設計変更は一切行っていない。**本番で既に2026-08-31から稼働しているソースコードを、Git管理下へそのまま復旧するだけの作業。**

本復旧作業ではPRODUCTIONへのdeploy・設定変更・Secret変更・IAM変更・Firestore書込みを一切行っていない。

## 4関数の本番revision・GCS source object・Cloud Build ID・deploy日時

**訂正**：ソースオブジェクトのアップロード日時と、Functionのdeploy/update日時は別のイベントであり、同一時刻として扱わない（以下、列を分けて記録する）。

| Function | 本番revision | GCS bucket | GCS object | object generation | source upload時刻（UTC） | Cloud Build ID | revision作成（deploy）時刻（UTC） |
|---|---|---|---|---:|---|---|---|
| `logInteraction` | `loginteraction-00007-col` | `gcf-v2-sources-546067044990-us-central1` | `logInteraction/function-source.zip` | `1788140501092827` | 2026-08-31T01:41:41.092Z | `6664579b-ff1a-4179-8bce-0fbc4c5d3d21` | 2026-08-31T01:41:41.993Z |
| `getFunnelDrilldown` | `getfunneldrilldown-00003-jad` | `gcf-v2-sources-546067044990-us-central1` | `getFunnelDrilldown/function-source.zip` | `1788140501010184` | 2026-08-31T01:41:41.010Z | `6664579b-ff1a-4179-8bce-0fbc4c5d3d21` | 2026-08-31T01:41:41.786Z |
| `getFunnelInsights` | `getfunnelinsights-00001-qes` | `gcf-v2-sources-546067044990-us-central1` | `getFunnelInsights/function-source.zip` | `1788140454771193` | 2026-08-31T01:40:54.771Z | `6664579b-ff1a-4179-8bce-0fbc4c5d3d21` | 2026-08-31T01:41:37.813Z |
| `getFunnelRecentActivity` | `getfunnelrecentactivity-00001-zet` | `gcf-v2-sources-546067044990-us-central1` | `getFunnelRecentActivity/function-source.zip` | `1788140500370373` | 2026-08-31T01:41:40.370Z | `6664579b-ff1a-4179-8bce-0fbc4c5d3d21` | 2026-08-31T01:41:41.412Z |

- **object generation**はGCSのオブジェクトバージョン番号（マイクロ秒epoch形式）。`source upload時刻`はこの値をUTC時刻へ変換したもので、`gcloud storage cp`によるsourceのアップロード完了時刻に相当する。
- **revision作成（deploy）時刻**は`gcloud run revisions describe <revision> --format="value(metadata.creationTimestamp)"`で個別に取得した値で、source upload時刻とは別のAPI呼び出し・別のタイムスタンプソースである。両者は近接している（数秒〜1分弱の差）が同一イベントではない。
- 4関数とも同一のCloud Build ID（`6664579b-ff1a-4179-8bce-0fbc4c5d3d21`）から、同一の`firebase deploy`操作で一括デプロイされたことを、build-image-uri・build-nameアノテーションの一致で確認済み。Secret値・環境変数値は記録していない（Secret参照名のみ`run.googleapis.com/secrets`アノテーションに現れるが、値そのものはCloud Run側にも本ドキュメントにも含まれない）。

（参考：比較対象として、現在も本番で稼働中の`getFunnelDashboard`（`getfunneldashboard-00004-xew`）・`lineWebhook`（`linewebhook-00004-diy`）は、別の2026-08-30T00:17:47Z台のCloud Build（build-name: `e755bf8a-96e0-4b58-b4d5-73de2025df53`）からのデプロイであり、今回復旧するバッチとは完全に別のデプロイ操作。）

## 本番ソースSHA-256（訂正：改行コードの正規化について）

`gcloud storage cp`で、本番のimmutable source（`gs://gcf-v2-sources-546067044990-us-central1/logInteraction/function-source.zip`ほか）を、既存リポジトリ外の一時ディレクトリへ取得し、展開したファイルのSHA-256を記録した。

**訂正**：初版では「Git保存後も本番とbyte単位で一致」と記載したが、これは不正確だった。正確には次のとおり：

- **本番取得物（immutable source ZIPを展開した生ファイル）の改行コードはCRLF**。
- このリポジトリは`core.autocrlf=true`（Windows環境のグローバル設定）のため、`git add`／`git commit`時にCRLF→LFへ自動変換されて**Git blob（実際にコミットされた内容）はLF**として保存される。作業ツリー上のファイル（ディスク上のファイル）はcheckout時にCRLFへ戻されるため、`sha256sum functions/index.js`等をこのWindows作業ツリー上でそのまま実行すると本番取得物と同じSHA-256が出る。しかし、**Gitが実際に保存している内容（コミットオブジェクト自体）はLFであり、そのSHA-256は別の値になる**。
- これはロジック上の改変ではなく、**Gitの改行コード正規化（autocrlf）による差**である。1文字たりともコードの意味・構文・実行結果は変わらない（LF→CRLF変換は空白文字の表現形式の違いのみ）。

| ファイル | 本番取得物（CRLF）のSHA-256 | Git保存物（LF blob）のSHA-256 |
|---|---|---|
| `functions/index.js` | `7b0b114dcacce5130aa69bd9a4c3a1a1d441c370d48e2e40dbc57d23354fd658` | `5cb572f3a5be9abf2911184fb9823e9b159d387a3c537bc48c86848e80185c98` |
| `functions/lib/funnel.js` | `fbae085c6dfe5463e1a97a999a0d0c71608d376ee7ddf130d6ac0e1cb3c858b9` | `b3291f08ded2cdb4082d00fe62c233ca49022b4e63df052b543dbf938e8825ae` |

**LF→CRLF変換後に一致することを実際に検証した**（`git show HEAD:functions/index.js | sed 's/$/\r/' | sha256sum`等）。変換後のSHA-256は本番取得物のCRLF版と完全一致し、上記2つの値が同一内容の異なる改行表現であることを機械的に確認済み。

無変更ファイル（改行コードの差異なし。本番取得物のSHA-256のみ記録）：

| ファイル | SHA-256（本番取得物） |
|---|---|
| `functions/dashboard.html`（無変更） | `5b06d54e44d46f3291362599c1f2a2eb45a1aac426b4b19607d96c28f95d1fb1` |
| `functions/lib/line.js`（無変更） | `e44136c9dc50abd141f3e3c7b2a4eb8da10e418a54e86891643ead51745734f1` |
| `functions/package.json`（無変更） | `761dc53f55651dcceb179c117701b2174fc6ff7b00873eed67badcffa39c136f` |
| `functions/package-lock.json`（無変更） | `85f923fd0a6a4e386f56ee0955d8e60bbba3d840505498764174b88d3a86bdf8` |

## 復旧したファイル

- `functions/index.js`
- `functions/lib/funnel.js`

（`functions/dashboard.html`・`functions/lib/line.js`・`functions/package.json`・`functions/package-lock.json`は本番バッチBと現行`main`とで完全一致していたため、変更していない。本番のバッチBには`functions/test/`が含まれていなかった＝2026-08-31のデプロイはtestディレクトリを含まないソースから行われたと考えられる。既存の`functions/test/`配下のテストファイルは`main`のものをそのまま維持している。）

## バッチAとの比較結果

現在`main`ブランチに存在する内容（＝2026-08-30T00:17:47Z台のバッチAデプロイと完全一致することを別途確認済み）を基準に、本番バッチBとの差分を精査した。

- `functions/dashboard.html`／`functions/lib/line.js`／`functions/package.json`／`functions/package-lock.json`：**完全一致（差分ゼロ）**。
- `functions/index.js`：**訂正：バッチBの`functions/index.js`は全611行**（初版に記載した「720行」は誤り）。`main`との差分は106行、すべて追加行。
- `functions/lib/funnel.js`：**全995行**。`main`との差分は616行、すべて追加行。
- **既存関数の変更範囲について（訂正）**：初版の「既存関数は一切変更されていない」は不正確だった。正確には次のとおり：

  **既存6つのexported Function本体（`submitForm`・`submitOtherInquiry`・`lineWebhook`・`syncSalesFunnel`・`getFunnelDashboard`・`funnelDashboard`）には変更なし。ただし共有処理`normalizeEvent()`には`from`取得が追加され、`logInteraction`には`from`と`visitor_hash`の保存が追加されている。その他は新規関数・定数・exportの追加。**

  具体的には：
  1. `index.js`：`require('./lib/funnel')`の分割代入へ`funnelDrilldown`・`funnelInsights`・`funnelRecentActivity`・`visitorToken`を追加（インポート追加のみ）。`logInteraction`内の`interaction_logs.add()`へ`from: event.from`・`visitor_hash: ...`の2行を追加（`logInteraction`自体の変更）。ファイル末尾へ`exports.getFunnelDrilldown`／`exports.getFunnelInsights`／`exports.getFunnelRecentActivity`の3関数を新規追加。
  2. `lib/funnel.js`：共有関数`normalizeEvent()`へ`from`フィールドの読み取り（`from: String(body && body.from || '').trim().slice(0, 100)`）を1行追加（`normalizeEvent()`自体の変更。`logInteraction`以外にも`submitForm`等が間接的にこの共有関数を経由するが、`from`の追加読み取りは既存の他フィールド処理に影響しない設計）。それ以外はすべて新規関数・新規定数の追加（`humanizeSource_`・`humanizeReferrer_`・`computeLeadScore_`・`funnelDrilldown`・`funnelInsights`・`funnelRecentActivity`等）。`module.exports`は既存エクスポート名の削除なく、新規エクスポート名の追加のみ（`LEGACY_TEST_EXCLUSIONS`・`funnelDrilldown`・`funnelInsights`・`funnelRecentActivity`・`visitorToken`）。
- **結論：現在本番で稼働中の`lineWebhook`・`getFunnelDashboard`・`submitForm`等（バッチA）のFunction本体を後退させる差分は無い。** `logInteraction`と共有関数`normalizeEvent()`への追加変更を除き、既存コードへの変更・削除は診断上ゼロ件。

## 本番変更・deployを行っていないことの確認

本復旧作業を通じて、`aokitosou-miniapp`プロジェクトへの`deploy`・Secret変更・IAM変更・Firestore書込み・Script Properties相当の設定変更は一切実行していない。実行したのは以下のREAD ONLY操作のみ：`gcloud functions list`／`gcloud run services list`／`gcloud run services describe`／`gcloud storage cp`（immutable sourceの取得）／`gcloud logging read`。ローカルgit worktree・ブランチへの変更のみを行った。

## テスト範囲（訂正・明確化）

- 既存テスト47件は全てPASS（`node --test test/*.test.js`。`functions/node_modules`未インストールのため`npm ci`で新規worktreeへローカルインストールしたうえで実行）。
- **この47件には、今回復旧した3つの新規API（`getFunnelDrilldown`／`getFunnelInsights`／`getFunnelRecentActivity`）専用のテストは含まれていない**。既存の`funnel.test.js`等は`normalizeEvent`・`aggregateRows`・`dashboardPayload`等の既存関数を対象にしたものであり、新規3関数・`funnelDrilldown`／`funnelInsights`／`funnelRecentActivity`・`humanizeSource_`／`humanizeReferrer_`／`computeLeadScore_`等の新規ロジックを直接検証するテストは1件も無い。
- **Emulator E2E（`functions/test/emulator.integration.js`等を実データ相当のエミュレータ上で動かす統合テスト）は今回の検証範囲に含まれていない**。`node --test`によるユニットテストのみを実行した。
- 独立監査（6 Astra）時の実行環境はNode 24。参考として、私自身が本復旧作業中に実行したテスト（47件PASS）はNode v22.14.0（本環境の実測値）。
- 本番runtimeはNode 22（`functions/package.json`の`engines.node`・Cloud Runのbase-image双方で確認済み）であり、独立監査の実行環境（Node 24）・私の実行環境（Node 22.14.0）とも**完全に同一環境ではない**。Node バージョン差に起因する挙動差の有無は今回検証していない。

## 次期改善時の必須監査項目（既知リスク・今回はコード修正なし）

本項目は、今回の本番コード救出そのものを否定するものではない。今後この機能を改善・拡張する際に、実装前・実装後の両方で必ず検証すべき既知リスクとして記録する。

**既知リスク**：
- `visitor_hash`が欠損しているログ（例：`visitor_id`が送信されなかった、または不正な形式で`normalizeEvent`が空文字にした場合）では、`groupVisits_`が`visitKey_(dayKey, '(不明)')`という同一キーへ同日中の複数訪問をすべてまとめてしまい、**別々の訪問者・別々のアクセスが1つの「訪問」へ誤結合される**可能性がある。この場合、本来無関係な別アクセスのLINEクリック・電話タップが同じ訪問の反応として扱われ、`computeLeadScore_`の見込み度が実態より過大に算出されるおそれがある。
- `logInteraction`は`interaction_logs.add()`（生ログの保存）を`recordWebEvent()`（`funnel_daily`の日次集計・冪等判定）より**先に実行**している。`eventSnapshot.exists`による冪等判定は`funnel_daily`側のトランザクション内でのみ行われるため、クライアントからの再送（ネットワーク再試行等）が発生した場合、`interaction_logs`には重複ドキュメントが複数回追加される可能性がある一方、`funnel_daily`の集計（サマリ）は冪等に保たれる。この結果、**`getFunnelDashboard`のサマリ件数と、`interaction_logs`を直接読む`getFunnelDrilldown`／`getFunnelInsights`のドリルダウン件数が不一致になる**おそれがある。

**必須テスト（次期改善時に追加すること）**：
- `from`×`referrer`の独立性（両方が同時に存在する場合・片方だけの場合の表示・集計）
- 未登録・欠損`from`（媒体コードマスタに無いコード、および`from`自体が空の場合の扱い）
- `visitor_hash`欠損（上記既知リスクの再現・誤結合が起きないことの確認）
- 同日再訪（同一visitor_hashによる同日複数訪問の扱い）
- JST期間境界（今月／今週／先月の境界日をまたぐケース）
- イベント再送（`logInteraction`への重複POST時、`interaction_logs`とサマリの整合性）
- page_viewなしの反応（LINEクリック・電話タップ単体で、対応する訪問記録が無い場合の「判定不能」扱い）
- サマリとdrilldown件数の一致（`getFunnelDashboard`の`metrics`と`getFunnelDrilldown`/`getFunnelInsights`の集計件数が常に一致すること）
- 新3 APIの認証・レスポンス契約（`FUNNEL_DASHBOARD_TOKEN`によるBearer認証の要否、レスポンスのフィールド名・形状がGAS側の期待と一致すること）

## 今後の注意事項（恒久ルール）

**今後、`aokitosou-miniapp`のFunctionsを一括で`firebase deploy`する前には、必ず本ドキュメントの内容（バッチA＝2026-08-30デプロイとバッチB＝2026-08-31デプロイという、2つの異なるソース状態が個別の関数ごとに本番稼働している事実）を踏まえ、`main`ブランチの内容が実際の本番稼働状態（全10関数分）と一致しているかを、本ドキュメントと同じ手法（`gcloud run services describe`のrevision・build-image-uri比較、可能なら`gcloud storage cp`によるimmutable source取得とSHA-256比較）で機械的に再確認すること。** `git log`上のコミット履歴だけを正本とみなさない（今回、正本コード約1,000行がコミット0件のまま本番稼働していた事実が実証されたため）。

`main`への`merge`、本番への`deploy`は本ドキュメント作成時点では未実施。取締役の別途明示指示を待つ。
