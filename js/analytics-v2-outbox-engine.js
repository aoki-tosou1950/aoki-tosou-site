(function() {
  'use strict';
  /**
   * V2 outbox ＋ PROD 401サーキットブレーカー 共有エンジン（独立監査再提出R9再監査
   * 対応・項目2で新設）。
   *
   * js/analytics-v2.js（フルトラッカー）とjs/analytics-v2-drain-only.js（V1へ
   * rollback後、既存V2 outboxだけをV2 writerへ排出する専用ローダー）の両方が、
   * この同一エンジンを呼び出して使う。
   *
   * 【新設の理由】
   * drain-onlyローダーが独自に停止判定・独自のリトライスケジュールを実装すると、
   * フルトラッカーの401サーキットブレーカー契約（全体停止・エスカレーション・
   * 回数上限・期限切れ破棄記録）と食い違う実装になり得る（実際、最初のdrain-only
   * 実装は401を無条件retryするだけの独自ロジックを持っており、フルトラッカーが
   * 既に停止中・finalStopped中でも無関係にoutboxを叩き続けてしまう欠陥があった）。
   * このエンジンへ両者の停止処理を一本化することで、「停止処理をもう一式独自実装
   * して食い違わせる」ことを構造的に防ぐ。
   *
   * 【呼び出し方】
   * window.__aokiAnalyticsV2OutboxEngineFactory_() を呼んでエンジンのインスタンスを
   * 1つ取得する（呼び出しごとに新しいtrialTimerHandle等のクロージャを持つ）。
   * V1/V2 analyticsは排他的切替のため、同一ページでanalytics-v2.jsと
   * analytics-v2-drain-only.jsが同時にエンジンを2つ生成することは設計上発生しない
   * （どちらか一方だけが1ページにロードされる。check_analytics_exclusive_switch.js
   * が両者の同時ロード自体を検査でBLOCKする）。両者は同じlocalStorageキー
   * （aoki_analytics_v2_outbox・aoki_analytics_v2_stop_state等）を参照するため、
   * 「V2稼働中に記録された停止状態を、rollback後のdrain-onlyがそのまま引き継いで
   * 尊重する」という契約が、実装を分けなくても自然に成立する。
   *
   * このファイル自体は新規イベントを一切生成しない（track()・buildEvent()相当の
   * 関数を持たない。呼び出し側がイベントを作ってenqueue()へ渡す設計）。
   */
  function createAokiAnalyticsV2OutboxEngine() {
    var ENDPOINT = 'https://us-central1-aokitosou-miniapp.cloudfunctions.net/logInteractionV2';
    var WRITER_GENERATION = 2;
    var OUTBOX_KEY = 'aoki_analytics_v2_outbox';
    var OUTBOX_DIAG_KEY = 'aoki_analytics_v2_outbox_diag';
    var OUTBOX_MAX_ITEMS = 50;
    var OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    var STOP_STATE_KEY = 'aoki_analytics_v2_stop_state';
    var RETRY_BACKOFF_MS = [15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000, 120 * 60 * 1000];
    var STOP_TRIAL_MAX_ATTEMPTS = 4;
    // 独立監査再提出R9：この20という値は「無制限リトライを防ぐ」という目的を満たす
    // ための暫定値であり、確定仕様として決定されたものではない（js/analytics-v2.jsの
    // 元のコメントと同じ留保。運用実績を踏まえて別途正式な値を決定する余地を残す）。
    var STOP_TOTAL_ATTEMPT_LIMIT = 20;
    var PERMANENT_DELETE_STATUSES = [400, 404, 413, 422, 403];
    var RETRYABLE_STATUSES = [408, 429];

    var memoryStopState = null;
    var trialTimerHandle = null;

    function safeLocalGet(key) { try { return window.localStorage.getItem(key); } catch (err) { return null; } }
    function safeLocalSet(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (err) { return false; } }
    function nowMs() { return Date.now(); }

    /* ---- outbox ---- */
    function loadOutbox() {
      try {
        var raw = safeLocalGet(OUTBOX_KEY);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) { return []; }
    }
    function saveOutbox(list) { safeLocalSet(OUTBOX_KEY, JSON.stringify(list)); }
    function loadDiagnostics() {
      try {
        var raw = safeLocalGet(OUTBOX_DIAG_KEY);
        var parsed = raw ? JSON.parse(raw) : null;
        return (parsed && typeof parsed === 'object') ? parsed : { expiredDiscardCount: 0 };
      } catch (err) { return { expiredDiscardCount: 0 }; }
    }
    function saveDiagnostics(diag) { safeLocalSet(OUTBOX_DIAG_KEY, JSON.stringify(diag)); }
    function recordExpiredDiscard(count) {
      if (!count) return;
      var diag = loadDiagnostics();
      diag.expiredDiscardCount = Number(diag.expiredDiscardCount || 0) + count;
      saveDiagnostics(diag);
    }
    /** 世代不一致・24時間超過を除去し、最大50件（新しい方を残す）へ切り詰める。
     * 24時間超過で破棄した件数を診断情報として記録する（フルトラッカー・drain-only
     * のどちらが呼んでも同じ診断記録へ積み上がる＝二重記録・記録漏れのいずれも無い）。 */
    function pruneOutbox(list) {
      var now = nowMs();
      var expiredCount = 0;
      var filtered = (list || []).filter(function(item) {
        if (!item || item.generation !== WRITER_GENERATION || !item.event || !item.event.event_id) return false;
        var expired = (now - Number(item.addedAt || 0)) > OUTBOX_MAX_AGE_MS;
        if (expired) expiredCount++;
        return !expired;
      });
      if (expiredCount) recordExpiredDiscard(expiredCount);
      if (filtered.length > OUTBOX_MAX_ITEMS) filtered = filtered.slice(filtered.length - OUTBOX_MAX_ITEMS);
      return filtered;
    }
    /** 新規イベントをoutboxへ積む。呼び出すのはフルトラッカー（track()）だけの想定
     * （drain-onlyはこの関数を一切呼ばない＝新規イベントを作らないという契約）。 */
    function enqueue(event) {
      var list = pruneOutbox(loadOutbox());
      list.push({ generation: WRITER_GENERATION, event: event, addedAt: nowMs(), attempts: 0, nextRetryAt: 0 });
      saveOutbox(pruneOutbox(list));
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

    /* ---- PROD 401 サーキットブレーカー（確定契約） ---- */
    function loadStopState() {
      try {
        var raw = safeLocalGet(STOP_STATE_KEY);
        if (raw) { var parsed = JSON.parse(raw); if (parsed && parsed.stoppedAt) return parsed; }
      } catch (err) {}
      return memoryStopState;
    }
    function saveStopState(state) {
      memoryStopState = state;
      safeLocalSet(STOP_STATE_KEY, state ? JSON.stringify(state) : '');
      if (!state) { try { window.localStorage.removeItem(STOP_STATE_KEY); } catch (err) {} }
    }
    function isStopped() { return !!loadStopState(); }
    /** drain-onlyローダー等が「finalStopped後は一切自動試験しない」ことを明示的に
     * 検査・アサートしやすくするための補助関数（scheduleTrialTimer_／
     * attemptTrialResend内部でも同じ判定を行っている。二重実装ではなく、同じ
     * loadStopState()の結果を見る読み取り専用のヘルパー）。 */
    function isFinalStopped() { var s = loadStopState(); return !!(s && s.finalStopped); }

    function clearTrialTimer_() {
      if (trialTimerHandle !== null) {
        try { window.clearTimeout(trialTimerHandle); } catch (err) {}
        trialTimerHandle = null;
      }
    }
    function scheduleTrialTimer_() {
      clearTrialTimer_();
      var stopState = loadStopState();
      if (!stopState || stopState.finalStopped) return;
      var nextTrialAt = Number(stopState.nextTrialAt || 0);
      if (!nextTrialAt) return;
      var delay = Math.max(0, nextTrialAt - nowMs());
      try {
        trialTimerHandle = window.setTimeout(function() {
          trialTimerHandle = null;
          attemptTrialResend();
        }, delay);
      } catch (err) {}
    }

    function backoffForAttempts(attempts) {
      var idx = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1);
      return RETRY_BACKOFF_MS[idx];
    }

    function beginStop() {
      var now = nowMs();
      saveStopState({ stoppedAt: now, trialCount: 0, totalAttempts: 0, nextTrialAt: now + backoffForAttempts(1), finalStopped: false });
      scheduleTrialTimer_();
    }
    function rescheduleTrialAfterFailedAttempt() {
      var state = loadStopState();
      var now = nowMs();
      var priorCount = Number(state && state.trialCount || 0);
      var newCount = priorCount + 1;
      var totalAttempts = Number(state && state.totalAttempts || 0);
      if (newCount >= STOP_TRIAL_MAX_ATTEMPTS) {
        saveStopState({ stoppedAt: state ? state.stoppedAt : now, trialCount: newCount, totalAttempts: totalAttempts, nextTrialAt: null, finalStopped: true });
        clearTrialTimer_();
      } else {
        saveStopState({ stoppedAt: state ? state.stoppedAt : now, trialCount: newCount, totalAttempts: totalAttempts, nextTrialAt: now + backoffForAttempts(newCount + 1), finalStopped: false });
        scheduleTrialTimer_();
      }
    }
    function rescheduleTrialWait() {
      var state = loadStopState();
      var now = nowMs();
      var count = Number(state && state.trialCount || 0);
      var totalAttempts = Number(state && state.totalAttempts || 0);
      saveStopState({ stoppedAt: state ? state.stoppedAt : now, trialCount: count, totalAttempts: totalAttempts, nextTrialAt: now + backoffForAttempts(count + 1), finalStopped: false });
      scheduleTrialTimer_();
    }
    function clearStop() { saveStopState(null); clearTrialTimer_(); }
    function resumeAfterStop() { clearStop(); }

    function classifyResponseStatus(status) {
      if (status >= 200 && status < 300) return 'success';
      if (status === 401) return 'stop';
      if (PERMANENT_DELETE_STATUSES.indexOf(status) >= 0) return 'permanent';
      if (RETRYABLE_STATUSES.indexOf(status) >= 0 || status >= 500) return 'retry';
      return 'retry';
    }

    /** 単一イベントをfetchで送信し、応答に応じてoutboxを更新する（確定契約）。
     * フルトラッカーの通常送信・試験再送、drain-onlyの排出のいずれからも、
     * この同じ関数だけを呼ぶ（401時のbeginStop呼び出しを含め、二重実装しない）。 */
    function sendViaFetch(item, onSettled) {
      if (typeof window.fetch !== 'function') { if (onSettled) onSettled('skipped'); return; }
      var event = item.event;
      try {
        window.fetch(ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event), keepalive: true
        }).then(function(res) {
          var kind = classifyResponseStatus(res ? res.status : 0);
          if (kind === 'success') {
            removeFromOutbox(event.event_id);
          } else if (kind === 'stop') {
            if (!isStopped()) beginStop();
          } else if (kind === 'permanent') {
            removeFromOutbox(event.event_id);
          } else {
            var attempts = Number(item.attempts || 0) + 1;
            updateOutboxItem(event.event_id, { attempts: attempts, nextRetryAt: nowMs() + backoffForAttempts(attempts) });
          }
          if (onSettled) onSettled(kind);
        }).catch(function() {
          var attempts = Number(item.attempts || 0) + 1;
          updateOutboxItem(event.event_id, { attempts: attempts, nextRetryAt: nowMs() + backoffForAttempts(attempts) });
          if (onSettled) onSettled('network_error');
        });
      } catch (err) {
        var attempts = Number(item.attempts || 0) + 1;
        updateOutboxItem(event.event_id, { attempts: attempts, nextRetryAt: nowMs() + backoffForAttempts(attempts) });
        if (onSettled) onSettled('exception');
      }
    }

    /** 通常時：保持中のoutboxのうち、再送猶予（nextRetryAt）を過ぎたものだけをfetchで
     * 送る。停止中は何もしない（呼び出し側が停止判定を別途行う必要はない＝この
     * ガードはここに1箇所だけ存在する）。 */
    function flushOutboxViaFetch() {
      if (isStopped()) return;
      var now = nowMs();
      pruneOutbox(loadOutbox()).forEach(function(item) {
        if (Number(item.nextRetryAt || 0) <= now) sendViaFetch(item);
      });
    }

    /** 停止中：outbox最古の1件だけを試験再送する。エスカレートするnextTrialAtを
     * 過ぎている場合にのみ試みる。呼び出し元はscheduleTrialTimer_()が設定する
     * 単発setTimeoutのコールバックとして呼ぶ想定（フルトラッカー・drain-onlyの
     * どちらから呼ばれても、同じ永続化されたtrialCount／totalAttempts／
     * nextTrialAt／finalStoppedの記録だけを見て判定する）。 */
    function attemptTrialResend() {
      var stopState = loadStopState();
      if (!stopState || stopState.finalStopped) return;
      var now = nowMs();
      if (now < Number(stopState.nextTrialAt || 0)) return;
      var list = pruneOutbox(loadOutbox());
      if (!list.length) { rescheduleTrialWait(); return; }
      var totalAttempts = Number(stopState.totalAttempts || 0);
      if (totalAttempts >= STOP_TOTAL_ATTEMPT_LIMIT) {
        saveStopState(Object.assign({}, stopState, { nextTrialAt: null, finalStopped: true }));
        clearTrialTimer_();
        return;
      }
      saveStopState(Object.assign({}, stopState, { totalAttempts: totalAttempts + 1 }));
      var oldest = list.reduce(function(a, b) { return Number(a.addedAt) <= Number(b.addedAt) ? a : b; });
      sendViaFetch(oldest, function(kind) {
        if (kind === 'success') { clearStop(); flushOutboxViaFetch(); }
        else if (kind === 'stop') { rescheduleTrialAfterFailedAttempt(); }
        else { rescheduleTrialWait(); }
      });
    }

    return {
      ENDPOINT: ENDPOINT, WRITER_GENERATION: WRITER_GENERATION,
      OUTBOX_MAX_ITEMS: OUTBOX_MAX_ITEMS, OUTBOX_MAX_AGE_MS: OUTBOX_MAX_AGE_MS,
      STOP_TRIAL_MAX_ATTEMPTS: STOP_TRIAL_MAX_ATTEMPTS, STOP_TOTAL_ATTEMPT_LIMIT: STOP_TOTAL_ATTEMPT_LIMIT,
      RETRY_BACKOFF_MS: RETRY_BACKOFF_MS,
      loadOutbox: loadOutbox, saveOutbox: saveOutbox, pruneOutbox: pruneOutbox, enqueue: enqueue,
      removeFromOutbox: removeFromOutbox, updateOutboxItem: updateOutboxItem,
      loadDiagnostics: loadDiagnostics,
      loadStopState: loadStopState, isStopped: isStopped, isFinalStopped: isFinalStopped,
      clearTrialTimer_: clearTrialTimer_, scheduleTrialTimer_: scheduleTrialTimer_,
      getTrialTimerHandle_: function() { return trialTimerHandle; },
      beginStop: beginStop, rescheduleTrialAfterFailedAttempt: rescheduleTrialAfterFailedAttempt,
      rescheduleTrialWait: rescheduleTrialWait, clearStop: clearStop, resumeAfterStop: resumeAfterStop,
      classifyResponseStatus: classifyResponseStatus, backoffForAttempts: backoffForAttempts,
      sendViaFetch: sendViaFetch, flushOutboxViaFetch: flushOutboxViaFetch, attemptTrialResend: attemptTrialResend
    };
  }

  try { window.__aokiAnalyticsV2OutboxEngineFactory_ = createAokiAnalyticsV2OutboxEngine; } catch (err) {}
})();
