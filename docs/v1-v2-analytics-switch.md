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
2. 16ページすべての `<script src="(\.\./)?js/analytics\.js" defer></script>` を、
   **`js/analytics-v2-outbox-engine.js`（共有エンジン）→ `js/analytics-v2.js`
   （フルトラッカー本体）の2本のscriptタグ、この順序**へ一括置換する
   （R9再監査対応・項目2でoutbox＋PROD 401サーキットブレーカーを共有エンジンへ
   分離したため、`analytics-v2.js`単体では動作しない。engineが後ろだと
   `window.__aokiAnalyticsV2OutboxEngineFactory_`が未定義のままV2本体が実行され、
   フェイルソフトで機能が丸ごと動かなくなる。1ページだけ先行させない。全ページを
   同一コミット・同一デプロイでまとめて切り替える）。
3. 置換直後、デプロイ前に `node functions/scripts/check_analytics_exclusive_switch.js`
   を実行し、`siteMode=v2`・PASSであることを確認する（`v1`のまま残っているページ・
   `mixed`状態を検出したらデプロイを中止する）。
4. 静的ホスティングへデプロイし、実際に本番ページで `js/analytics-v2.js` が
   ロードされ、V1由来のイベントが新規発生しなくなったことを確認する。
5. **Q2（QR一気通貫受入確認）を実施する（下記§1.1参照）。** Q2完了・PASS確認まで
   切替作業は完了とみなさない（URL確認だけで完了扱いにしない）。

### 1.1 Q1／Q2：QR実機受入確認（取締役が確定済みの定義）

PROD切替の最終受入確認として、以下のQ1・Q2を実施する。

- **Q1（実施済み）**：QR画像の復号（実際のQR画像が正しいURLへ復号されること）と、
  復号後URLへのHTTP到達確認。本ラウンドより前のセッションで完了済み。
- **Q2（PROD切替後に実施。本ラウンドでは未実施）**：M101名刺QR
  （`https://aoki-tosou.net/?from=meishi`）とM202チラシQR
  （`https://aoki-tosou.net/?from=area_check_v1`）を、PROD切替後の実サイトに対して
  **同一ブラウザでM101→M202の順に実際にアクセス**し、以下を一気通貫で確認する
  （URL確認だけでQ2完了とはみなさない）：
  1. QR遷移後も正しい`from`が保持される。
  2. V2 writerが受理し、Firestoreのraw log・`visit_sessions`へ正しい媒体帰属が
     記録される。
  3. 同日・30分以内でも、M101→M202の媒体変更で別`visit_id`となり、M202がM101へ
     誤帰属しない（`js/analytics-v2.js`の境界判定ロジック§「訪問境界」の実データ
     確認）。
  4. V2 reader経由で、GAS本番画面の媒体表示・訪問数・ドリルダウンが記録と一致する。

  Q2は実機QRスキャン・実ブラウザ操作を伴うため、AIが単独で完結できない。PROD切替
  実施時に、必要な実機操作を1操作ずつ人間へ案内する。

## 3. V2→V1 rollback手順とdrain-only互換ローダー

V2稼働後に何らかの理由でV1へロールバックする場合、ロールバック時点でユーザーの
localStorage（`aoki_analytics_v2_outbox`）に、V2が生成したがまだサーバーへ送達
確認できていないイベントが残っていることがある。ロールバック後にV2トラッカー
自体を動かし続けると排他契約に違反するため、**新規イベント生成を一切行わず、
既存V2 outboxの排出だけを行うdrain-only互換ローダー**
（[`js/analytics-v2-drain-only.js`](../js/analytics-v2-drain-only.js)）を新設した。

### 3.1 drain-onlyローダーの契約（R9再監査対応・項目2で全面改訂）

drain-onlyローダーは、outbox・PROD 401サーキットブレーカーの実装を一切独自に
持たない。[`js/analytics-v2-outbox-engine.js`](../js/analytics-v2-outbox-engine.js)
（フルトラッカーと共有する単一のエンジン）を呼び出すだけであり、これにより
「停止処理を2箇所で独立実装して食い違わせる」ことを構造的に防いでいる。

- 新規`visit_id`・新規`event_id`の発行を行わない（engineの`enqueue()`を一切呼ばない。
  `track()`相当のAPIを公開しない）。
- click/tel:リンクのbindingを行わない。
- `visibilitychange`/`pagehide`でのbeacon送信を行わない（離脱時の新規beacon経路を
  持たない。ページ読み込み時点で既存outboxの排出を試みるだけ）。
- 送信先は**V2 writer（`logInteractionV2`）のみ**。V1 writer（`logInteraction`）へは
  絶対に送らない（V2形状のイベントをV1エンドポイントへ送ると型不正・データ破損に
  なるため）。エンドポイント定数自体がengine側で1つしか無く、構造的にV1 writerへは
  送れない。
- outbox世代・期限管理契約（`OUTBOX_MAX_AGE_MS=24時間`）はengineが一元管理する。
  V2稼働時に生成されたエントリは、生成から**最大24時間**で自動的に排出対象から
  外れ、それ以降は破棄され二度と送信を試みない（破棄件数はフルトラッカーと
  同じ診断キー`aoki_analytics_v2_outbox_diag`へ記録される）。
- **PROD 401サーキットブレーカーは、フルトラッカーと完全に同じengineの
  `beginStop`/`attemptTrialResend`/`scheduleTrialTimer_`をそのまま呼ぶ**（初版の
  「401はretry扱いにして次回に回す」という独自ロジックは廃止済み）。401が発生
  すれば、フルトラッカーと同一のサーキットブレーカー（全体停止・15→30→60→120分の
  エスカレーション・4回上限でfinalStopped）に入る。**ロールバック時点で既にV2側の
  停止状態（同一localStorageキー `aoki_analytics_v2_stop_state`）が存在する場合、
  drain-onlyはそれをそのまま尊重し、停止中・finalStopped中に迂回してoutboxを
  叩き続けることはない**（既存停止状態を引き継いだrollbackケースとして
  回帰テスト済み）。

これは19件の回帰テスト（[`functions/test/analytics-v2-drain-only.test.js`](../functions/test/analytics-v2-drain-only.test.js)）
で検証済み：outbox空なら何もしない／期限内エントリはV2 writerへ排出される／
V1 writerへは構造的に送れない／24時間超過エントリは破棄されそれ以降送信されない
（境界値含む・診断カウンタ記録含む）／`nextRetryAt`猶予中は強制排出しない／
200で削除・400等の恒久失敗でも削除／**401はフルトラッカーと同一の全体停止を
引き起こす（per-item retryではない）**／**既にフルトラッカーが停止中・
finalStopped中の状態でロードされても、その停止状態を尊重し迂回しない**／
**401が4回連続するとフルトラッカーと同じくfinalStoppedになり、以後は自動試験
しない（回数上限を共有）**／`window.fetch`が無い環境でも例外を投げない／
別世代のエントリは無視・破棄する／ソースコード自体が新規イベント生成・
sendBeaconの呼び出しを一切含まない（静的確認）。

`check_analytics_exclusive_switch.js`は、drain-onlyローダーがV2フルトラッカーと
同一ページに同時に存在する状態（設計上の取り違え・二重ロード）もBLOCK対象として
検査する。V1稼働中ページへdrain-onlyローダーを追加で載せることは許可される
（これがまさにロールバック直後の想定用途）。加えて、R9再監査対応・項目2からは
`js/analytics-v2-outbox-engine.js`の`<script>`タグが存在し、かつV2/drain-onlyより
前に置かれていることも検査する（engine未ロードだとフェイルソフトで機能が丸ごと
動かなくなるため）。

### 3.2 rollback手順

1. 16ページすべての `js/analytics-v2.js` の`<script>`タグを `js/analytics.js`
   （V1フルトラッカーへ復帰）へ戻すと同時に、`js/analytics-v2-outbox-engine.js`
   （共有エンジン。drain-onlyが実行時依存する）と
   `js/analytics-v2-drain-only.js` を、**この順序**で同じページへ追加する
   （V1フルトラッカーとdrain-onlyローダー＋engineの共存は許可される組み合わせ。
   engineが無い、またはdrain-onlyより後ろだと`window.__aokiAnalyticsV2OutboxEngineFactory_`
   が未定義のままdrain-only本体が実行され、フェイルソフトで機能が丸ごと動かなくなる）。
2. `check_analytics_exclusive_switch.js`を実行し、`siteMode=v1`・PASS
   （drain-onlyローダー・engineの存在はsiteMode判定そのものには影響しないが、
   engine未ロード・順序違反はBLOCK対象として検査される）であることを確認する。
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
