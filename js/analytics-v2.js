(function() {
  'use strict';
  /**
   * Web流入媒体識別精度改善・単位EF：schemaVersion:2クライアントwriter（2026-09-07新規）。
   * 既存 js/analytics.js（V1・logInteractionエンドポイント）はこのファイルとは無関係に
   * 無変更のまま残り、並行して動作し続ける。本番サイトへどちらを読み込むか（V1のみ／
   * V2のみ／両方）は、このファイル単体のデプロイでは切り替わらない（HTMLの<script>タグ
   * 側の変更が必要。今回のセッションでは本番HTMLへの反映は行っていない＝未接続）。
   *
   * V1との違い（意図的な仕様変更）：
   * - 正規化・検証は一切クライアント側で行わない。生値（visitMediaCode / visitWebSource /
   *   visitorId / visitorIdPersisted）をそのまま送り、サーバー側（functions/lib/funnelV2.js
   *   の normalizeMediaCode / normalizeWebSource / evaluateVisitorIdentity）が正規化する。
   *   クライアント側の判定をサーバーが信用することは一切ない。
   * - 流入元の帰属（media/webSource）はsessionStorageのvisit単位（30分の無操作で新規visit）
   *   で固定する。V1のlocalStorage・訪問をまたいだ長期固定とは異なる。
   * - fetch優先・sendBeaconは離脱時（visibilitychange=hidden／pagehide）のみのフォール
   *   バックとして使う（V1はsendBeacon優先）。
   * - 送信できなかったイベントはoutbox（localStorage）へ最大50件・24時間だけ保持し、
   *   同一event_idのまま再送する（サーバー側recordWebEventV2の冪等性に依存し、新しい
   *   event_idを発行し直さない＝重複計上させない）。
   * - サーバーから401（Origin不許可等）を受けたら1時間、送信自体を停止する
   *   （不正クライアント・障害設定での連打を避けるサーキットブレーカー）。
   *   window.aokiAnalyticsV2.resumeAfterStop()で試験的に即時再開できる（QA専用）。
   */
  try {
    var ENDPOINT = 'https://us-central1-aokitosou-miniapp.cloudfunctions.net/logInteractionV2';
    var WRITER_GENERATION = 1; // outboxのスキーマ世代。将来writerの契約を変えたら上げる。
    var VISIT_TIMEOUT_MS = 30 * 60 * 1000; // 30分の無操作でvisit境界（新しいvisit_id）
    var OUTBOX_KEY = 'aoki_analytics_v2_outbox';
    var OUTBOX_MAX_ITEMS = 50;
    var OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    var VISITOR_ID_KEY = 'aoki_analytics_v2_visitor_id';
    var VISIT_STATE_KEY = 'aoki_analytics_v2_visit';
    var STOP_UNTIL_KEY = 'aoki_analytics_v2_stopped_until';
    var STOP_DURATION_MS = 60 * 60 * 1000; // 401受信後の停止時間

    function safeLocalGet(key) { try { return window.localStorage.getItem(key); } catch (err) { return null; } }
    function safeLocalSet(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (err) { return false; } }
    function safeLocalRemove(key) { try { window.localStorage.removeItem(key); } catch (err) {} }
    function safeSessionGet(key) { try { return window.sessionStorage.getItem(key); } catch (err) { return null; } }
    function safeSessionSet(key, value) { try { window.sessionStorage.setItem(key, value); return true; } catch (err) { return false; } }

    function nowMs() { return Date.now(); }

    // event_id: EVENT_ID_PATTERN /^[A-Za-z0-9_-]{12,100}$/ ・ visit_id: VISIT_ID_PATTERN
    // /^[A-Za-z0-9_-]{16,100}$/ ・ visitorId: 同じ文字集合で16文字以上（サーバー側
    // VISITOR_ID_PATTERNと同一形式）。いずれもprefix込みでこれらの範囲に収まる長さにする。
    function randomToken() {
      try {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
      } catch (err) {}
      return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }

    function getOrCreateVisitorId() {
      var existing = safeLocalGet(VISITOR_ID_KEY);
      if (existing) return { id: existing, persisted: true };
      var id = 'vid2_' + randomToken();
      var wrote = safeLocalSet(VISITOR_ID_KEY, id);
      // wrote=falseの場合（localStorage不可）でもidはこのページ内では一貫して使うが、
      // 永続化できていないためvisitorIdPersisted=falseとして正直に送る
      // （サーバー側evaluateVisitorIdentityがhashReliable=falseへ縮退させる）。
      return { id: id, persisted: wrote };
    }

    function currentUrlParams() {
      try { return new URLSearchParams(window.location.search); } catch (err) { return new URLSearchParams(); }
    }

    // visit開始時にだけ計算する生の帰属候補（サーバー側で正規化・検証される前提の生値）。
    function computeRawAttribution() {
      var mediaCode = currentUrlParams().get('from') || '';
      var webSource = '';
      try {
        if (!document.referrer) {
          webSource = 'direct';
        } else {
          var refHost = new URL(document.referrer).hostname;
          var curHost = window.location.hostname;
          webSource = (refHost.toLowerCase() === curHost.toLowerCase()) ? 'direct' : refHost;
        }
      } catch (err) { webSource = ''; }
      return { mediaCode: mediaCode, webSource: webSource };
    }

    function loadVisitState() {
      try {
        var raw = safeSessionGet(VISIT_STATE_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
      } catch (err) { return null; }
    }
    function saveVisitState(state) { safeSessionSet(VISIT_STATE_KEY, JSON.stringify(state)); }

    /** 30分の無操作でvisit境界（正本仕様：boundary判定）。既存visitが有効ならlastActivityAt
     * だけ更新して再利用し、無効（無し・タイムアウト）なら新しいvisit_id・新しい帰属捕捉で
     * 作り直す。 */
    function getOrStartVisit() {
      var now = nowMs();
      var state = loadVisitState();
      if (state && state.visitId && (now - Number(state.lastActivityAt || 0)) <= VISIT_TIMEOUT_MS) {
        state.lastActivityAt = now;
        saveVisitState(state);
        return state;
      }
      var attribution = computeRawAttribution();
      var landingPage = safeHref();
      var next = {
        visitId: 'vst2_' + randomToken(),
        startedAt: now,
        lastActivityAt: now,
        mediaCode: attribution.mediaCode,
        webSource: attribution.webSource,
        landingPage: landingPage
      };
      saveVisitState(next);
      return next;
    }

    function safeHref() { try { return window.location.href; } catch (err) { return ''; } }
    function safeReferrerHost() {
      try {
        if (!document.referrer) return '';
        return new URL(document.referrer).hostname.toLowerCase();
      } catch (err) { return ''; }
    }

    /* ---- outbox（送信できなかった/未確認のイベントの一時保管） ---- */
    function loadOutbox() {
      try {
        var raw = safeLocalGet(OUTBOX_KEY);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) { return []; }
    }
    function saveOutbox(list) { safeLocalSet(OUTBOX_KEY, JSON.stringify(list)); }
    /** 世代不一致（古いwriterの残骸）と24時間超過を除去し、最大50件（新しい方を残す）
     * へ切り詰める。 */
    function pruneOutbox(list) {
      var now = nowMs();
      var filtered = (list || []).filter(function(item) {
        return item && item.generation === WRITER_GENERATION &&
          (now - Number(item.addedAt || 0)) <= OUTBOX_MAX_AGE_MS && item.event && item.event.event_id;
      });
      if (filtered.length > OUTBOX_MAX_ITEMS) filtered = filtered.slice(filtered.length - OUTBOX_MAX_ITEMS);
      return filtered;
    }
    function enqueue(event) {
      var list = pruneOutbox(loadOutbox());
      list.push({ generation: WRITER_GENERATION, event: event, addedAt: nowMs() });
      saveOutbox(pruneOutbox(list));
    }
    function dequeue(eventId) {
      saveOutbox(loadOutbox().filter(function(item) { return !item.event || item.event.event_id !== eventId; }));
    }

    /* ---- PROD 401停止・試験再開 ---- */
    function isStopped() {
      var until = Number(safeLocalGet(STOP_UNTIL_KEY) || 0);
      return until > nowMs();
    }
    function stopSending() { safeLocalSet(STOP_UNTIL_KEY, String(nowMs() + STOP_DURATION_MS)); }
    function resumeAfterStop() { safeLocalRemove(STOP_UNTIL_KEY); } // QA専用：試験的に即時再開する

    function buildEvent(eventType, extra) {
      var visit = getOrStartVisit();
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

    /** fetch優先の送信。成功（2xx）ならoutboxから外す。401ならサーキットブレーカーを起動
     * する。それ以外の失敗はoutboxに残し、次回flushで同一event_idのまま再送する
     * （新しいevent_idを発行しない＝サーバー側の重複排除に頼れる）。 */
    function sendViaFetch(event) {
      if (typeof window.fetch !== 'function') return false;
      try {
        window.fetch(ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event), keepalive: true
        }).then(function(res) {
          if (res && res.status === 401) { stopSending(); return; }
          if (res && res.ok) { dequeue(event.event_id); }
        }).catch(function() { /* ネットワーク失敗：outboxに残したまま次回再送 */ });
        return true;
      } catch (err) { return false; }
    }

    /** 離脱時専用。navigator.sendBeaconはレスポンスを観測できないため、送信をキューへ
     * 投入できた時点で楽観的にoutboxから外す（401等の失敗はこの経路では検知できない、
     * という既知の制約。恒常的な失敗は次回ページ表示時のfetch再送フローで拾われる）。 */
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
      if (isStopped()) return; // outboxには積むが、停止中は送信自体を試みない
      if (!sendViaFetch(event)) sendViaBeaconBestEffort(event) && dequeue(event.event_id);
    }

    /** ページ表示時：前回積み残したoutboxを、同一event_idのままfetchで再送する。 */
    function flushOutboxViaFetch() {
      if (isStopped()) return;
      pruneOutbox(loadOutbox()).forEach(function(item) { sendViaFetch(item.event); });
    }

    /** 離脱時：fetchのthenを待てないため、可能な限りsendBeaconで再送する。 */
    function flushOutboxViaBeacon() {
      pruneOutbox(loadOutbox()).forEach(function(item) {
        if (sendViaBeaconBestEffort(item.event)) dequeue(item.event.event_id);
      });
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
      // outboxのstale/世代不一致エントリを起動時に一度掃除しておく（他タブ経由の残骸対策）。
      saveOutbox(pruneOutbox(loadOutbox()));
      flushOutboxViaFetch();
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
      _internal: {
        buildEvent: buildEvent, getOrStartVisit: getOrStartVisit, computeRawAttribution: computeRawAttribution,
        pruneOutbox: pruneOutbox, loadOutbox: loadOutbox, enqueue: enqueue, dequeue: dequeue,
        WRITER_GENERATION: WRITER_GENERATION, VISIT_TIMEOUT_MS: VISIT_TIMEOUT_MS,
        OUTBOX_MAX_ITEMS: OUTBOX_MAX_ITEMS, OUTBOX_MAX_AGE_MS: OUTBOX_MAX_AGE_MS,
        STOP_DURATION_MS: STOP_DURATION_MS, ENDPOINT: ENDPOINT
      }
    };
  } catch (err) {}
})();
