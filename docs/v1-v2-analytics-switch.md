# V1/V2 analytics 排他切替・rollback設計（独立監査再提出R9・項目7）

本ドキュメントは、Web集客ファネルのanalyticsトラッキングをV1（`js/analytics.js`）から
V2（`js/analytics-v2.js`）へ切り替える際の手順・自動検査・rollback設計を定める。
**実PROD操作（実際のHTML書き換え・実デプロイ）は本ラウンドでは行わない。手順と
自動検査だけを完成させる。**

## 0. 確定契約（禁止事項）

- V1/V2 analyticsは**排他的切替**とする。並行起動は禁止。
- 同一HTMLページが `js/analytics.js` と `js/analytics-v2.js` の両方を同時にロード
  してはならない。
- サイト全体として、一部ページだけV1・一部ページだけV2という中途半端な切替状態を
  放置してはならない（切替は全ページ一括で完了させる）。

これらは [`functions/scripts/check_analytics_exclusive_switch.js`](../functions/scripts/check_analytics_exclusive_switch.js)
により機械的に検査できる（[`functions/test/check_analytics_exclusive_switch.test.js`](../functions/test/check_analytics_exclusive_switch.test.js)
で回帰確認済み）。

## 1. 現状（本ラウンド時点の実測）

サイト直下・`works/`配下の全16 HTMLページ（`index.html` / `about.html` /
`case001.html` / `case002.html` / `faq.html` / `works.html` /
`works/case001.html`〜`works/case010.html` / `works/template.html`）は、
現時点ですべて `<script src="js/analytics.js" defer></script>`（V1）のみを
ロードしている。V2は現在どのページにも組み込まれていない
（`check_analytics_exclusive_switch.js`実行で`siteMode=v1`・PASSとして確認済み）。

## 2. V1→V2 切替手順（実行時に人間が承認の上で行う）

1. 事前条件（本ドキュメント§4「COPY_TEST/PROD切替前の最終BLOCK条件」を含む、
   R9完了報告の「4. COPY_TEST接続ready/not-ready表」の全項目がreadyであること）
   を満たしていることを確認する。
2. 16ページすべての `<script src="(\.\./)?js/analytics\.js" defer></script>` を
   `<script src="$1js/analytics-v2.js" defer></script>` へ一括置換する
   （1ページだけ先行させない。全ページを同一コミット・同一デプロイでまとめて切り替える）。
3. 置換直後、デプロイ前に `node functions/scripts/check_analytics_exclusive_switch.js`
   を実行し、`siteMode=v2`・PASSであることを確認する（`v1`のまま残っているページ・
   `mixed`状態を検出したらデプロイを中止する）。
4. 静的ホスティングへデプロイし、実際に本番ページで `js/analytics-v2.js` が
   ロードされ、V1由来のイベントが新規発生しなくなったことを確認する。

## 3. V2→V1 rollback手順とdrain-only互換ローダー

V2稼働後に何らかの理由でV1へロールバックする場合、ロールバック時点でユーザーの
localStorage（`aoki_analytics_v2_outbox`）に、V2が生成したがまだサーバーへ送達
確認できていないイベントが残っていることがある。ロールバック後にV2トラッカー
自体を動かし続けると排他契約に違反するため、**新規イベント生成を一切行わず、
既存V2 outboxの排出だけを行うdrain-only互換ローダー**
（[`js/analytics-v2-drain-only.js`](../js/analytics-v2-drain-only.js)）を新設した。

### 3.1 drain-onlyローダーの契約

- 新規`visit_id`・新規`event_id`の発行を行わない（`track()`相当のAPIを公開しない）。
- click/tel:リンクのbindingを行わない。
- `visibilitychange`/`pagehide`でのbeacon送信を行わない（離脱時の新規beacon経路を
  持たない。ページ読み込み時点で既存outboxの排出を試みるだけ）。
- 送信先は**V2 writer（`logInteractionV2`）のみ**。V1 writer（`logInteraction`）へは
  絶対に送らない（V2形状のイベントをV1エンドポイントへ送ると型不正・データ破損に
  なるため）。
- 既存のoutbox世代・期限管理契約（`OUTBOX_MAX_AGE_MS=24時間`。`js/analytics-v2.js`の
  `pruneOutbox`と同一基準）をそのまま踏襲する。V2稼働時に生成されたエントリは、
  生成から**最大24時間**で自動的に排出対象から外れ、それ以降は破棄され二度と
  送信を試みない。
- PROD 401サーキットブレーカー（`beginStop`等）を持たない。401は`retry`扱いとし、
  次回ページ表示時の再試行に任せる（恒久停止状態を新設しない）。

これは11件の回帰テスト（[`functions/test/analytics-v2-drain-only.test.js`](../functions/test/analytics-v2-drain-only.test.js)）
で検証済み：outbox空なら何もしない／期限内エントリはV2 writerへ排出される／
V1 writerへは構造的に送れない（エンドポイント定数がV2 writer固定）／24時間超過
エントリは破棄されそれ以降送信されない（境界値含む）／`nextRetryAt`猶予中は
強制排出しない／200で削除・400等の恒久失敗でも削除・401は保持して次回に回す／
`window.fetch`が無い環境でも例外を投げない／別世代のエントリは無視・破棄する。

`check_analytics_exclusive_switch.js`は、drain-onlyローダーがV2フルトラッカーと
同一ページに同時に存在する状態（設計上の取り違え・二重ロード）もBLOCK対象として
検査する。V1稼働中ページへdrain-onlyローダーを追加で載せることは許可される
（これがまさにロールバック直後の想定用途）。

### 3.2 rollback手順

1. 16ページすべての `js/analytics-v2.js` を `js/analytics.js` へ戻す
   （V1フルトラッカーへ復帰）と同時に、同じページへ
   `<script src="(\.\./)?js/analytics-v2-drain-only.js" defer></script>` を
   追加する（V1フルトラッカーとdrain-onlyローダーの共存は許可される組み合わせ）。
2. `check_analytics_exclusive_switch.js`を実行し、`siteMode=v1`・PASS
   （drain-onlyローダーの存在はこの判定に影響しない）であることを確認する。
3. サーバー側の**V2 writer（`logInteractionV2`）はrollback後、最低24時間は
   維持する**（deployを維持し続ける。停止しない）。これはdrain-onlyローダー側の
   「outboxエントリは生成から最大24時間で排出対象から外れる」という契約と対に
   なる：どんなに遅くクライアントがページを開いても、生成から24時間以内に
   一度でもページが開かれれば、V2 writerがまだ受理可能な状態でoutboxを排出できる。
4. rollbackから24時間が経過した後、運用上の判断でdrain-onlyローダーの
   `<script>`タグをページから外してよい（それ以降は残存outboxがあっても
   `pruneOutbox`基準で自動的に排出対象外＝破棄されるため、ローダー自体を
   残しても実害はないが、不要なリクエストを避けるため外すことを推奨する）。
   V2 writerを24時間より前に停止してはならない。

## 4. Firestore indexREADY前にreader接続しない、というガード

VERIFY読み取り系4関数（`logInteractionV2Verify`書込み以外の読み取り専用3関数＋
将来のCOPY_TEST/PROD reader接続）は、対象のFirestore
compositeインデックスが`READY`状態になる前に接続してはならない。これは
`firebase deploy --only firestore:indexes`後、`gcloud firestore indexes composite list`
（または Firebase Console）でインデックスの状態が`READY`であることを人間または
自動検査が確認してから初めてreader側の接続作業（COPY_TEST GAS Script Property
への`VERIFY_READ_TOKEN`設定・実VERIFY reader確認）に進む、という**運用手順上の
順序制約**である。本ラウンドでは実インデックスのデプロイ自体を行っていないため
（R9完了報告「4. COPY_TEST接続ready/not-ready表」でnot-readyと記載）、このガードは
現時点では「まだreader接続作業に進んではならない」という状態を裏付けるものであり、
自動化されたコード上のチェックではなく、切替手順書（本ドキュメント）とREADY表の
突き合わせという運用ゲートとして扱う。

## 5. まとめ：排他性がどう保証されるか

| ページの状態 | `check_analytics_exclusive_switch.js`の判定 |
|---|---|
| 全ページV1のみ | PASS（`siteMode=v1`） |
| 全ページV2のみ | PASS（`siteMode=v2`） |
| 同一ページにV1+V2 | BLOCK（並行起動禁止違反） |
| 一部V1・一部V2 | BLOCK（サイト全体のモード不一致） |
| V1 + drain-onlyローダー | PASS（rollback直後の許可された組み合わせ） |
| V2 + drain-onlyローダー | BLOCK（設計上の取り違え・二重ロード） |

この検査をデプロイ前ゲート（`predeploy_check_dataenv.js`と並ぶ静的チェック）として
組み込むことで、「V1/V2の同時稼働案は禁止」という契約を、レビュー担当者の目視では
なく機械的に強制できる。
