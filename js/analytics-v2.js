(function() {
  'use strict';
  /**
   * Web流入媒体識別精度改善・単位EF：schemaVersion:2クライアントwriter
   * （2026-09-07新規・独立監査「本番BLOCK」対応で訪問境界・outbox契約を全面改訂）。
   * 既存 js/analytics.js（V1・logInteractionエンドポイント）はこのファイルとは無関係に
   * 無変更のまま残り、並行して動作し続ける。
   *
   * 正規化・検証は一切クライアント側で行わない。生値（visitMediaCode / visitWebSource /
   * visitorId / visitorIdPersisted）をそのまま送り、サーバー側（funnelV2.js）が正規化する。
   *
   * --- 訪問境界（独立監査差し戻し対応・確定アルゴリズム） ---
   * 各イベント送信時に、現在ページのfrom／外部referrerから「複合boundaryKey」を計算し、
   * 直前に保存済みのboundaryKeyと比較する。
   *   - 30分の無操作でタイムアウト（新visit）。
   *   - タイムアウト前でも、今回のboundaryKeyが直前と異なり、かつ今回何らかの信号
   *     （from・外部referrerのいずれか）を持つ場合は新visit（fromだけ変化・referrerだけ
   *     変化・両方変化のいずれも対象）。
   *   - 今回のページが信号を一切持たない場合（内部遷移等）は、タイムアウト前なら
   *     現在の帰属をそのまま維持する（推測で上書きしない）。
   *   - 媒体（from）はあるが外部referrerが無い場合：webSource=''／サーバー側status='none'。
   *   - 媒体も外部referrerも無い場合のみ：webSource='direct'（真の直接訪問）。
   *   - 外部referrerがある場合：mediaの有無に関わらずwebSourceへ生のreferrerホストを送る。
   * --- outbox（確定契約） ---
   *   - sendBeaconが成功しても即座には削除しない。次回fetchで2xxが確認できるまで保持する
   *     （sendBeaconは送達を確認できないため）。
   *   - 2xx：削除。400/404/413/422：恒久的に削除（再送しても成功しない）。
   *     403（Origin不許可）：恒久的に削除。408/429/5xx／通信失敗：保持し再送する。
   *   - PROD 401：送信全体を停止（サーキットブレーカー）。15分後、またはページを新規に
   *     開いた時点のいずれか早い方で、outbox最古の1件だけを試験再送する。成功すれば停止解除。
   *   - 再送間隔（保持系の失敗）：1回目失敗=15分後、2回目=30分後、3回目=60分後、
   *     4回目以降=120分後（上限）。24時間経過または50件超過分は破棄し、破棄件数を
   *     診断情報として記録する。
   *   - localStorage/sessionStorageが使えない環境でも、同一ページが生存している間は
   *     メモリ上のvisit_id／visitorIdをそのまま使い回す（ページ内で毎回新規発行しない）。
   */
  try {
    var ENDPOINT = 'https://us-central1-aokitosou-miniapp.cloudfunctions.net/logInteractionV2';
    var WRITER_GENERATION = 2; // 訪問境界・outbox契約を全面改訂したため世代を1→2へ引き上げる
    var VISIT_TIMEOUT_MS = 30 * 60 * 1000;
    var OUTBOX_KEY = 'aoki_analytics_v2_outbox';
    var OUTBOX_DIAG_KEY = 'aoki_analytics_v2_outbox_diag';
    var OUTBOX_MAX_ITEMS = 50;
    var OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    var VISITOR_ID_KEY = 'aoki_analytics_v2_visitor_id';
    var VISIT_STATE_KEY = 'aoki_analytics_v2_visit';
    var STOP_STATE_KEY = 'aoki_analytics_v2_stop_state';
    var STOP_TRIAL_INTERVAL_MS = 15 * 60 * 1000; // 401停止中の試験再送の待機間隔（固定・エスカレートしない）
    // 保持系失敗（408/429/5xx/通信失敗）の再送間隔テーブル：1回目15分・2回目30分・3回目60分・4回目以降120分。
    var RETRY_BACKOFF_MS = [15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000, 120 * 60 * 1000];
    var PERMANENT_DELETE_STATUSES = [400, 404, 413, 422, 403];
    var RETRYABLE_STATUSES = [408, 429];

    // --- ページ生存中のメモリフォールバック（storage不能時でも同一ページ内は使い回す） ---
    var memoryVisitState = null;
    var memoryVisitorId = null;
    var memoryStopState = null;

    function safeLocalGet(key) { try { return window.localStorage.getItem(key); } catch (err) { return null; } }
    function safeLocalSet(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (err) { return false; } }
    function safeSessionGet(key) { try { return window.sessionStorage.getItem(key); } catch (err) { return null; } }
    function safeSessionSet(key, value) { try { window.sessionStorage.setItem(key, value); return true; } catch (err) { return false; } }

    function nowMs() { return Date.now(); }

    function randomToken() {
      try {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
      } catch (err) {}
      return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }

    function safeHref() { try { return window.location.href; } catch (err) { return ''; } }

    /* ---- visitorId（長期・localStorage。不能時はページ内メモリを使い回す） ---- */
    function getOrCreateVisitorId() {
      var existing = safeLocalGet(VISITOR_ID_KEY);
      if (existing) { memoryVisitorId = existing; return { id: existing, persisted: true }; }
      if (memoryVisitorId) return { id: memoryVisitorId, persisted: false };
      var id = 'vid2_' + randomToken();
      memoryVisitorId = id;
      var wrote = safeLocalSet(VISITOR_ID_KEY, id);
      return { id: id, persisted: wrote };
    }

    /* ---- 現在ページの生信号（from／外部referrer） ---- */
    function currentUrlParams() {
      try { return new URLSearchParams(window.location.search); } catch (err) { return new URLSearchParams(); }
    }
    function currentSignal() {
      var fromParam = null;
      try { var raw = currentUrlParams().get('from'); if (raw) fromParam = raw; } catch (err) {}
      var referrerHost = null;
      try {
        if (document.referrer) {
          var refHost = new URL(document.referrer).hostname.toLowerCase();
          var curHost = window.location.hostname.toLowerCase();
          if (refHost !== curHost) referrerHost = refHost; // 外部（同一originは信号扱いしない）
        }
      } catch (err) {}
      return { from: fromParam, referrerHost: referrerHost };
    }
    /** 信号（from／外部referrer）が一切無ければnull（＝比較対象にしない＝現在帰属を維持）。 */
    function boundaryKeyOf(signal) {
      if (signal.from == null && signal.referrerHost == null) return null;
      return (signal.from || '') + '|' + (signal.referrerHost || '');
    }
    /** 生のvisitMediaCode／visitWebSourceを信号から導出する（サーバー側で正規化される前提）。
     * 媒体あり・外部referrerなし→webSource=''（正本仕様：status='none'）。
     * 媒体も外部referrerも無い→'direct'（真の直接訪問のみ）。
     * 外部referrerがあれば、媒体の有無に関わらず生のreferrerホストを送る。 */
    function rawAttributionFromSignal(signal) {
      var mediaCode = signal.from || '';
      var webSource;
      if (signal.referrerHost) webSource = signal.referrerHost;
      else if (mediaCode) webSource = '';
      else webSource = 'direct';
      return { mediaCode: mediaCode, webSource: webSource };
    }

    /* ---- visit状態（sessionStorage。不能時はページ内メモリを使い回す） ---- */
    function loadVisitState() {
      try {
        var raw = safeSessionGet(VISIT_STATE_KEY);
        if (raw) { var parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') return parsed; }
      } catch (err) {}
      return memoryVisitState;
    }
    function saveVisitState(state) {
      memoryVisitState = state;
      safeSessionSet(VISIT_STATE_KEY, JSON.stringify(state));
    }

    /** 訪問境界の確定判定（正本仕様・独立監査再提出版）。イベント送信のたびに呼ばれる。 */
    function getOrUpdateVisit() {
      var now = nowMs();
      var state = loadVisitState();
      var signal = currentSignal();
      var key = boundaryKeyOf(signal);
      var timedOut = !state || (now - Number(state.lastActivityAt || 0)) > VISIT_TIMEOUT_MS;
      var keyChanged = !timedOut && !!state && key !== null && key !== state.boundaryKey;

      if (!timedOut && !keyChanged) {
        // 現在の訪問を維持（信号なし、または信号ありでも直前と同一）。
        state.lastActivityAt = now;
        saveVisitState(state);
        return state;
      }

      // 新しい訪問：境界を切り、今回の信号から帰属を再取得する。
      var attribution = rawAttributionFromSignal(signal);
      var next = {
        visitId: 'vst2_' + randomToken(),
        startedAt: now,
        lastActivityAt: now,
        boundaryKey: key, // nullの場合（初回訪問が無信号）もそのまま保存し、次回signal付きイベントとの比較に使う
        mediaCode: attribution.mediaCode,
        webSource: attribution.webSource,
        landingPage: safeHref()
      };
      saveVisitState(next);
      return next;
    }

    function safeReferrerHost() {
      try {
        if (!document.referrer) return '';
        return new URL(document.referrer).hostname.toLowerCase();
      } catch (err) { return ''; }
    }

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
     * 24時間超過で破棄した件数を診断情報として記録する。 */
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

    /* ---- PROD 401 サーキットブレーカー ---- */
    function loadStopState() {
      try {
        var raw = safeLocalGet(STOP_STATE_KEY);
        if (raw) { var parsed = JSON.parse(raw); if (parsed && parsed.stoppedAt) return parsed; }
      } catch (err) {}
      return memoryStopState;
    }
    function saveStopState(state) { memoryStopState = state; safeLocalSet(STOP_STATE_KEY, state ? JSON.stringify(state) : ''); if (!state) { try { window.localStorage.removeItem(STOP_STATE_KEY); } catch (err) {} } }
    function isStopped() { return !!loadStopState(); }
    function beginStop() {
      var now = nowMs();
      saveStopState({ stoppedAt: now, nextTrialAt: now + STOP_TRIAL_INTERVAL_MS });
    }
    function rescheduleTrial() {
      var state = loadStopState();
      var now = nowMs();
      saveStopState({ stoppedAt: state ? state.stoppedAt : now, nextTrialAt: now + STOP_TRIAL_INTERVAL_MS });
    }
    function clearStop() { saveStopState(null); }
    /** QA専用：試験的に即時再開する。 */
    function resumeAfterStop() { clearStop(); }

    function buildEvent(eventType, extra) {
      var visit = getOrUpdateVisit();
      var visitor = getOrCreateVisitorId();
      var event = {
        schemaVersion: 2,
        event_id: 'evt2_' + randomToken(),
        visit_id: visit.visitId,
        occurredAt: nowMs(),
        eventType: eventType,
        visitMediaCode: visit.mediaCode,
        visitWebSource: visit.webSource,
        visitorId: visitor.id,
        visitorIdPersisted: visitor.persisted,
        currentPage: safeHref(),
        landingPage: visit.landingPage || safeHref(),
        referrerHost: safeReferrerHost(),
        contactChannel: ''
      };
      if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) event[k] = extra[k]; } }
      return event;
    }

    function classifyResponseStatus(status) {
      if (status >= 200 && status < 300) return 'success';
      if (status === 401) return 'stop';
      if (PERMANENT_DELETE_STATUSES.indexOf(status) >= 0) return 'permanent';
      if (RETRYABLE_STATUSES.indexOf(status) >= 0 || status >= 500) return 'retry';
      return 'retry'; // 未知のステータスは安全側（保持・再送）に倒す
    }
    function backoffForAttempts(attempts) {
      var idx = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1);
      return RETRY_BACKOFF_MS[idx];
    }

    /** 単一イベントをfetchで送信し、応答に応じてoutboxを更新する（確定契約）。 */
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
            beginStop(); // itemはoutboxに残す（次回の試験再送対象）
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
      } catch (err) { if (onSettled) onSettled('exception'); }
    }

    /** 離脱時専用：sendBeaconで送るが、成功してもoutboxからは削除しない
     * （送達確認ができないため。次回ページ表示時のfetch再送で2xxを確認してから削除する）。 */
    function sendViaBeaconBestEffort(event) {
      try {
        if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
        var blob = new Blob([JSON.stringify(event)], { type: 'application/json' });
        return navigator.sendBeacon(ENDPOINT, blob);
      } catch (err) { return false; }
    }

    function track(eventType, extra) {
      var event = buildEvent(eventType, extra);
      enqueue(event);
      if (isStopped()) return; // outboxには積むが、停止中は送信を試みない（次回の試験再送・復帰を待つ）
      sendViaFetch({ event: event, attempts: 0 });
    }

    /** 通常時：保持中のoutboxのうち、再送猶予（nextRetryAt）を過ぎたものだけをfetchで送る。 */
    function flushOutboxViaFetch() {
      if (isStopped()) return;
      var now = nowMs();
      pruneOutbox(loadOutbox()).forEach(function(item) {
        if (Number(item.nextRetryAt || 0) <= now) sendViaFetch(item);
      });
    }

    /** 停止中：outbox最古の1件だけを試験再送する。15分経過後、またはページ新規表示時に呼ぶ。
     * force=trueはページ新規表示（init）専用：正本仕様「15分後、またはページを新規に開いた
     * 時点のいずれか早い方」のうち後者を満たすため、15分の待機を無視して即時試験する。 */
    function attemptTrialResend(force) {
      var stopState = loadStopState();
      if (!stopState) return;
      var now = nowMs();
      if (!force && now < Number(stopState.nextTrialAt || 0)) return;
      var list = pruneOutbox(loadOutbox());
      if (!list.length) { rescheduleTrial(); return; }
      var oldest = list.reduce(function(a, b) { return Number(a.addedAt) <= Number(b.addedAt) ? a : b; });
      sendViaFetch(oldest, function(kind) {
        if (kind === 'success') { clearStop(); flushOutboxViaFetch(); }
        else { rescheduleTrial(); }
      });
    }

    /** 離脱時：fetchのthenを待てないため、可能な限りsendBeaconで送る（削除はしない）。 */
    function flushOutboxViaBeacon() {
      pruneOutbox(loadOutbox()).forEach(function(item) { sendViaBeaconBestEffort(item.event); });
    }

    function isLineUrl(href) {
      try { var host = new URL(href, safeHref()).hostname; return host === 'line.me' || host.slice(-8) === '.line.me'; } catch (err) { return false; }
    }
    function bindClicks() {
      document.addEventListener('click', function(event) {
        try {
          var link = event.target.closest && event.target.closest('a[href]');
          if (!link) return;
          var href = link.getAttribute('href') || '';
          if (isLineUrl(href)) return track('line_click', { contactChannel: 'LINE' });
          if (href.toLowerCase().indexOf('tel:') === 0) track('phone_click', { contactChannel: '電話' });
        } catch (err) {}
      }, true);
    }

    function init() {
      saveOutbox(pruneOutbox(loadOutbox()));
      if (isStopped()) attemptTrialResend(true); // ページ新規表示＝正本仕様の「早い方」のトリガー
      else flushOutboxViaFetch();
      track('page_view');
      bindClicks();
      try {
        document.addEventListener('visibilitychange', function() {
          if (document.visibilityState === 'hidden') flushOutboxViaBeacon();
        });
      } catch (err) {}
      try { window.addEventListener('pagehide', flushOutboxViaBeacon); } catch (err) {}
    }

    init();

    window.aokiAnalyticsV2 = {
      track: track,
      resumeAfterStop: resumeAfterStop, // QA専用：401サーキットブレーカーの試験的即時解除
      isStopped: isStopped,
      getDiagnostics: loadDiagnostics,
      _internal: {
        buildEvent: buildEvent, getOrUpdateVisit: getOrUpdateVisit, currentSignal: currentSignal,
        boundaryKeyOf: boundaryKeyOf, rawAttributionFromSignal: rawAttributionFromSignal,
        pruneOutbox: pruneOutbox, loadOutbox: loadOutbox, enqueue: enqueue,
        classifyResponseStatus: classifyResponseStatus, backoffForAttempts: backoffForAttempts,
        attemptTrialResend: attemptTrialResend, flushOutboxViaFetch: flushOutboxViaFetch,
        loadStopState: loadStopState, beginStop: beginStop,
        WRITER_GENERATION: WRITER_GENERATION, VISIT_TIMEOUT_MS: VISIT_TIMEOUT_MS,
        OUTBOX_MAX_ITEMS: OUTBOX_MAX_ITEMS, OUTBOX_MAX_AGE_MS: OUTBOX_MAX_AGE_MS,
        STOP_TRIAL_INTERVAL_MS: STOP_TRIAL_INTERVAL_MS, RETRY_BACKOFF_MS: RETRY_BACKOFF_MS,
        ENDPOINT: ENDPOINT
      }
    };
  } catch (err) {}
})();
