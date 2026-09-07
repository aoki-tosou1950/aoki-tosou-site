(function() {
  'use strict';
  /**
   * V2→V1 rollback時専用のdrain-only互換ローダー（独立監査再提出R9・項目7で新設）。
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
   * V1 writer（logInteraction。V1スキーマ専用）へは絶対に送らない
   * （V2形状のイベントをV1エンドポイントへ送ると型不正・データ破損になる）。
   *
   * 【24時間の排出上限】
   * 既存のoutbox世代・期限管理契約（OUTBOX_MAX_AGE_MS=24時間。js/analytics-v2.jsの
   * pruneOutboxと同一の基準）をそのまま踏襲する。V2稼働時に生成されたエントリは、
   * 生成から最大24時間で自動的に排出対象から外れる（それ以上は破棄され、二度と
   * 送信を試みない）。運用上の対応表と同じ数値：「V2 writerはrollback後最低24時間
   * 維持する」（サーバー側を最低24時間は受け入れ可能な状態に保つ）と対になる
   * クライアント側の契約である。
   *
   * 【このスクリプトが行わないこと（意図的なスコープ限定）】
   *  - 新規visitId・新規event_idの発行（buildEvent相当の処理は一切持たない）
   *  - click/tel:リンクのbinding（新規イベントの発生源を増やさない）
   *  - visibilitychange/pagehideでのsendBeacon送信（離脱時の新規beacon経路は
   *    持たない。既存outboxの排出はfetchのみで行う＝ページが開いている間だけ
   *    働けばよく、離脱時の即時送達保証までは持たない設計）
   *  - PROD 401サーキットブレーカー（beginStop等）。ロールバック後の短期間・
   *    有限回数の排出専用スクリプトであり、恒久的な停止状態を持つ必要が無い
   *    （401等はretry扱いにし、次回ページ表示時の再試行に任せる）
   */
  try {
    var ENDPOINT = 'https://us-central1-aokitosou-miniapp.cloudfunctions.net/logInteractionV2';
    // js/analytics-v2.jsと同一のWRITER_GENERATION・OUTBOX_KEYを参照する（別の
    // outboxを新設しない。V2稼働中に生成された実際のoutboxをそのまま読む）。
    var WRITER_GENERATION = 2;
    var OUTBOX_KEY = 'aoki_analytics_v2_outbox';
    var OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    var RETRY_BACKOFF_MS = [15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000, 120 * 60 * 1000];
    var PERMANENT_DELETE_STATUSES = [400, 404, 413, 422, 403];
    var RETRYABLE_STATUSES = [408, 429];

    function nowMs() { return Date.now(); }
    function safeLocalGet(key) { try { return window.localStorage.getItem(key); } catch (err) { return null; } }
    function safeLocalSet(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (err) { return false; } }

    function loadOutbox() {
      try {
        var raw = safeLocalGet(OUTBOX_KEY);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) { return []; }
    }
    function saveOutbox(list) { safeLocalSet(OUTBOX_KEY, JSON.stringify(list)); }
    /** js/analytics-v2.jsのpruneOutboxと同じ基準（世代一致・24時間以内）。
     * このスクリプトは新規enqueueを行わないため、diagnostics記録（破棄件数）は
     * 持たない（フルトラッカー側の責務のまま。二重記録を避ける）。 */
    function pruneOutbox(list) {
      var now = nowMs();
      return (list || []).filter(function(item) {
        if (!item || item.generation !== WRITER_GENERATION || !item.event || !item.event.event_id) return false;
        return (now - Number(item.addedAt || 0)) <= OUTBOX_MAX_AGE_MS;
      });
    }
    function removeFromOutbox(eventId) {
      saveOutbox(loadOutbox().filter(function(item) { return !item.event || item.event.event_id !== eventId; }));
    }
    function updateOutboxItem(eventId, patch) {
      var list = loadOutbox();
      var changed = false;
      list = list.map(function(item) {
        if (item.event && item.event.event_id === eventId) { changed = true; return Object.assign({}, item, patch); }
        return item;
      });
      if (changed) saveOutbox(list);
    }
    function backoffForAttempts(attempts) {
      var idx = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1);
      return RETRY_BACKOFF_MS[idx];
    }
    /** js/analytics-v2.jsのclassifyResponseStatusとほぼ同じだが、401専用の
     * サーキットブレーカーを持たないため、401もretry（保持・次回再試行）として
     * 扱う（このスクリプト自身が新たな恒久停止状態を作らない）。 */
    function classifyResponseStatus(status) {
      if (status >= 200 && status < 300) return 'success';
      if (PERMANENT_DELETE_STATUSES.indexOf(status) >= 0) return 'permanent';
      if (RETRYABLE_STATUSES.indexOf(status) >= 0 || status >= 500) return 'retry';
      return 'retry'; // 401を含む未知のステータスは安全側（保持・再送）に倒す
    }

    function drainOne(item) {
      if (typeof window.fetch !== 'function') return;
      var event = item.event;
      try {
        window.fetch(ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event), keepalive: true
        }).then(function(res) {
          var kind = classifyResponseStatus(res ? res.status : 0);
          if (kind === 'success' || kind === 'permanent') {
            removeFromOutbox(event.event_id);
          } else {
            var attempts = Number(item.attempts || 0) + 1;
            updateOutboxItem(event.event_id, { attempts: attempts, nextRetryAt: nowMs() + backoffForAttempts(attempts) });
          }
        }).catch(function() {
          var attempts = Number(item.attempts || 0) + 1;
          updateOutboxItem(event.event_id, { attempts: attempts, nextRetryAt: nowMs() + backoffForAttempts(attempts) });
        });
      } catch (err) {
        var attempts = Number(item.attempts || 0) + 1;
        updateOutboxItem(event.event_id, { attempts: attempts, nextRetryAt: nowMs() + backoffForAttempts(attempts) });
      }
    }

    /** 期限切れ（24時間超過）エントリをprune（破棄）で除去した上で、再送猶予
     * （nextRetryAt）を過ぎたものだけを排出する。V1 writerへは一切送らない
     * （このスクリプトはENDPOINT定数を1つしか持たず、それはV2 writerのみ）。 */
    function drainDueEntries() {
      var now = nowMs();
      var pruned = pruneOutbox(loadOutbox());
      saveOutbox(pruned); // 期限切れエントリの破棄をlocalStorageへ反映する
      pruned.forEach(function(item) {
        if (Number(item.nextRetryAt || 0) <= now) drainOne(item);
      });
    }

    // このスクリプト自身は新規イベントを一切生成しない（track()相当の関数を
    // 持たない）。ページ読み込み時に既存のoutboxがあれば排出を試みるだけで、
    // 以後は追加のイベントリスナー（click／visibilitychange／pagehide）も
    // 一切登録しない＝新規追跡経路を増やさない。
    drainDueEntries();

    window.aokiAnalyticsV2DrainOnly = {
      _internal: {
        loadOutbox: loadOutbox, pruneOutbox: pruneOutbox, drainDueEntries: drainDueEntries,
        classifyResponseStatus: classifyResponseStatus, backoffForAttempts: backoffForAttempts,
        ENDPOINT: ENDPOINT, OUTBOX_MAX_AGE_MS: OUTBOX_MAX_AGE_MS, WRITER_GENERATION: WRITER_GENERATION,
        RETRY_BACKOFF_MS: RETRY_BACKOFF_MS
      }
    };
  } catch (err) {}
})();
