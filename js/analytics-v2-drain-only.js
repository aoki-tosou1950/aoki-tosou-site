(function() {
  'use strict';
  /**
   * V2→V1 rollback時専用のdrain-only互換ローダー（独立監査再提出R9・項目7で新設。
   * R9再監査対応・項目2で js/analytics-v2-outbox-engine.js への委譲へ全面改訂）。
   *
   * 【設計方針・確定契約】
   * V1（js/analytics.js）とV2（js/analytics-v2.js）のanalyticsは排他的切替とする
   * （どちらか一方だけを常時ロードする。並行起動は禁止＝同一ページで両方の
   * フルトラッカーを同時にロードしない）。
   *
   * V2稼働中に本番をV1へロールバックした場合、V2稼働中に生成され、まだサーバーへ
   * 送達確認できていないイベントがユーザーのlocalStorage（aoki_analytics_v2_outbox）
   * に残っていることがある。V1へロールバックした後にこのoutboxを放置すると、
   * そのイベントは永久に失われる。かといって、ロールバック後もjs/analytics-v2.js
   * （フルトラッカー：新規visit境界計算・click binding・新規page_view送出を行う）を
   * そのまま動かし続けると「V1/V2排他切替・並行起動禁止」という確定契約に違反する。
   *
   * このスクリプトは、その中間解：新規イベントの生成・追跡を一切行わない
   * （getOrUpdateVisit相当の訪問境界計算・click binding・track('page_view')の
   * いずれも行わない）が、既にlocalStorageに残っているV2 outboxのエントリだけを、
   * 引き続きV2 writer（V2の完全なスキーマを理解できるエンドポイント）へ排出する。
   * V1 writer（logInteraction。V1スキーマ専用）へは絶対に送らない。
   *
   * 【R9再監査対応・項目2：停止状態の契約維持（重要）】
   * 初版実装は「401はretry扱いにして次回に回す」という、フルトラッカーとは別の
   * 独自の停止判定ロジックを持っており、フルトラッカーが既に停止中・finalStopped
   * であっても無関係にoutboxを叩き続けてしまう欠陥があった（通常V2の停止状態を
   * 迂回する実装になっていた）。
   *
   * 現在はjs/analytics-v2-outbox-engine.jsが提供する、フルトラッカーと完全に同じ
   * outbox＋PROD 401サーキットブレーカー実装（同じlocalStorageキー・同じ
   * beginStop／attemptTrialResend／STOP_TRIAL_MAX_ATTEMPTS／STOP_TOTAL_ATTEMPT_LIMIT）
   * をそのまま呼び出す。停止処理をこのファイル側で独自に再実装している箇所は
   * 一切無い：
   *  - 401が発生すれば、engineのsendViaFetchが自動的にbeginStop()を呼び、
   *    フルトラッカーと全く同じ全体停止（サーキットブレーカー）に入る。
   *  - 既にフルトラッカーが停止中・finalStopped状態でこのローダーがロードされた
   *    場合も、engine.isStopped()／engine.flushOutboxViaFetch()内部のガードに
   *    より、この停止状態をそのまま尊重する（迂回しない）。
   *  - 停止中は、フルトラッカーのinit()と全く同じ手順（scheduleTrialTimer_()に
   *    よる限定試験再送）で、outbox最古の1件だけを試験する。finalStopped後は
   *    engine内部のガードにより新しいタイマーを一切予約しない（自動試験を
   *    無期限に繰り返さない）。
   *  - 期限切れ（24時間超過）エントリの破棄・診断記録（expiredDiscardCount）も
   *    engine.pruneOutbox()を経由するため、フルトラッカーと同じ基準・同じ記録先
   *    （aoki_analytics_v2_outbox_diag）にそのまま積み上がる（二重実装・記録漏れ
   *    なし）。
   *
   * 【このスクリプトが行わないこと（意図的なスコープ限定）】
   *  - engine.enqueue()を一切呼ばない＝新規visitId・新規event_idの発行を一切行わない
   *    （buildEvent相当の処理を持たない）。
   *  - click/tel:リンクのbinding（新規イベントの発生源を増やさない）。
   *  - visibilitychange/pagehideでのsendBeacon送信（離脱時の新規beacon経路は
   *    持たない。既存outboxの排出はfetchのみで行う）。
   *
   * 【HTML側の読み込み順序】
   * js/analytics-v2-outbox-engine.js → js/analytics-v2-drain-only.js の順で
   * <script>タグをロードすること（js/analytics-v2.jsと同じ制約。
   * docs/v1-v2-analytics-switch.md参照）。
   */
  try {
    var engine = window.__aokiAnalyticsV2OutboxEngineFactory_();

    /** 期限切れエントリの破棄はengine.pruneOutbox()が内部で行う（loadOutbox()の
     * 戻り値には反映されないが、pruneOutbox()を呼んだ時点でlocalStorageの
     * 診断カウンタ・outbox本体は更新される。ここでの明示的なsaveOutboxは、
     * フルトラッカーのinit()と同じく「読み込み時に一度、期限切れ分を確実に
     * 掃除しておく」ための操作）。 */
    function pruneNow_() {
      engine.saveOutbox(engine.pruneOutbox(engine.loadOutbox()));
    }

    /** フルトラッカーのinit()と全く同じ分岐（停止中ならタイマー予約・そうでなければ
     * 即座にflush）。停止判定・タイマー管理のロジックはここには一切無く、すべて
     * engine側の同じ関数を呼ぶだけ（食い違いようがない）。 */
    function drainDueEntries() {
      pruneNow_();
      if (engine.isStopped()) {
        engine.scheduleTrialTimer_();
      } else {
        engine.flushOutboxViaFetch();
      }
    }

    // このスクリプト自身は新規イベントを一切生成しない（engine.enqueue()を一度も
    // 呼ばない＝track()相当の関数を持たない）。ページ読み込み時に既存のoutboxが
    // あれば排出を試みるだけで、以後は追加のイベントリスナー（click／
    // visibilitychange／pagehide）も一切登録しない＝新規追跡経路を増やさない。
    drainDueEntries();

    window.aokiAnalyticsV2DrainOnly = {
      _internal: {
        engine_: engine,
        drainDueEntries: drainDueEntries,
        loadOutbox: engine.loadOutbox, pruneOutbox: engine.pruneOutbox,
        loadStopState: engine.loadStopState, isStopped: engine.isStopped, isFinalStopped: engine.isFinalStopped,
        classifyResponseStatus: engine.classifyResponseStatus, backoffForAttempts: engine.backoffForAttempts,
        scheduleTrialTimer_: engine.scheduleTrialTimer_, clearTrialTimer_: engine.clearTrialTimer_,
        getTrialTimerHandle_: engine.getTrialTimerHandle_,
        attemptTrialResend: engine.attemptTrialResend, flushOutboxViaFetch: engine.flushOutboxViaFetch,
        ENDPOINT: engine.ENDPOINT, OUTBOX_MAX_AGE_MS: engine.OUTBOX_MAX_AGE_MS, WRITER_GENERATION: engine.WRITER_GENERATION,
        RETRY_BACKOFF_MS: engine.RETRY_BACKOFF_MS, STOP_TRIAL_MAX_ATTEMPTS: engine.STOP_TRIAL_MAX_ATTEMPTS,
        STOP_TOTAL_ATTEMPT_LIMIT: engine.STOP_TOTAL_ATTEMPT_LIMIT
      }
    };
  } catch (err) {}
})();
