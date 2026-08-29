(function() {
  'use strict';
  try {
    var LOG_ENDPOINT = 'https://us-central1-aokitosou-miniapp.cloudfunctions.net/logInteraction';
    var STORAGE_SOURCE = 'aoki_analytics_source';
    var STORAGE_FIRST_SEEN = 'aoki_analytics_first_seen_at';
    var STORAGE_LANDING_PAGE = 'aoki_analytics_landing_page';
    var STORAGE_VISITOR = 'aoki_analytics_visitor_v1';
    var STORAGE_ATTRIBUTION = 'aoki_analytics_attribution_v1';

    function nowIso() { return new Date().toISOString(); }
    function safeGet(key) { try { return window.localStorage.getItem(key) || ''; } catch (err) { return ''; } }
    function safeSet(key, value) { try { window.localStorage.setItem(key, value); } catch (err) {} }
    function randomId(prefix) {
      try { if (window.crypto && window.crypto.randomUUID) return prefix + window.crypto.randomUUID().replace(/-/g, ''); } catch (err) {}
      return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    function visitorId() {
      var id = safeGet(STORAGE_VISITOR);
      if (!id) { id = randomId('v_'); safeSet(STORAGE_VISITOR, id); }
      return id;
    }
    function params() { try { return new URLSearchParams(window.location.search); } catch (err) { return new URLSearchParams(); } }
    function pageUrl() { return window.location.href; }
    function pageReferrer() { return document.referrer || ''; }
    function referrerSource() {
      try {
        if (!document.referrer) return 'direct';
        var host = new URL(document.referrer).hostname.toLowerCase();
        if (host === window.location.hostname.toLowerCase()) return 'internal';
        return host.replace(/^www\./, '');
      } catch (err) { return '不明'; }
    }
    function currentAttribution() {
      var query = params(), from = query.get('from') || '', utmSource = query.get('utm_source') || '', utmMedium = query.get('utm_medium') || '', utmCampaign = query.get('utm_campaign') || '';
      var source = from || (utmSource ? [utmSource, utmMedium].filter(Boolean).join(' / ') : referrerSource());
      return { source: source || '不明', from: from, utm_source: utmSource, utm_medium: utmMedium, utm_campaign: utmCampaign };
    }
    function initAttribution() {
      var current = currentAttribution(), stored = safeGet(STORAGE_ATTRIBUTION);
      if (!stored || current.from || current.utm_source || (current.source !== 'direct' && current.source !== 'internal')) {
        stored = JSON.stringify(current);
        safeSet(STORAGE_ATTRIBUTION, stored);
      }
      try { safeSet(STORAGE_SOURCE, (JSON.parse(stored) || current).source || '不明'); } catch (err) { safeSet(STORAGE_SOURCE, current.source); }
      if (!safeGet(STORAGE_FIRST_SEEN)) safeSet(STORAGE_FIRST_SEEN, nowIso());
      if (!safeGet(STORAGE_LANDING_PAGE)) safeSet(STORAGE_LANDING_PAGE, pageUrl());
    }
    function attribution() {
      try { return JSON.parse(safeGet(STORAGE_ATTRIBUTION)) || currentAttribution(); } catch (err) { return currentAttribution(); }
    }
    function payload(eventType, contactChannel) {
      var a = attribution();
      return {
        event_id: randomId('e_'), visitor_id: visitorId(), event_type: eventType, contact_channel: contactChannel || '',
        source: a.source || '不明', from: a.from || '', utm_source: a.utm_source || '', utm_medium: a.utm_medium || '', utm_campaign: a.utm_campaign || '',
        first_seen_at: safeGet(STORAGE_FIRST_SEEN), landing_page: safeGet(STORAGE_LANDING_PAGE) || pageUrl(), current_page: pageUrl(), referrer: pageReferrer()
      };
    }
    function sendLog(eventType, contactChannel) {
      try {
        var body = JSON.stringify(payload(eventType, contactChannel));
        if (navigator.sendBeacon) {
          try { if (navigator.sendBeacon(LOG_ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return; } catch (err) {}
        }
        if (window.fetch) fetch(LOG_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function() {});
      } catch (err) {}
    }
    function isLineUrl(href) { try { var host = new URL(href, pageUrl()).hostname; return host === 'line.me' || host.slice(-8) === '.line.me'; } catch (err) { return false; } }
    function isExternalFormUrl(href) { try { var url = new URL(href, pageUrl()).href; return url.indexOf('https://aokitosou-miniapp.web.app/inquiry-other.html') === 0 || url.indexOf('https://aokitosou-miniapp.web.app/index.html') === 0; } catch (err) { return false; } }
    function appendAttributionToUrl(url) {
      try {
        var parsed = new URL(url, pageUrl()), a = attribution();
        if (a.source && !parsed.searchParams.get('from')) parsed.searchParams.set('from', a.from || a.source);
        ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function(key) { if (a[key] && !parsed.searchParams.get(key)) parsed.searchParams.set(key, a[key]); });
        if (safeGet(STORAGE_FIRST_SEEN) && !parsed.searchParams.get('first_seen_at')) parsed.searchParams.set('first_seen_at', safeGet(STORAGE_FIRST_SEEN));
        if (safeGet(STORAGE_LANDING_PAGE) && !parsed.searchParams.get('landing_page')) parsed.searchParams.set('landing_page', safeGet(STORAGE_LANDING_PAGE));
        return parsed.toString();
      } catch (err) { return url; }
    }
    function bindClicks() {
      document.addEventListener('click', function(event) {
        try {
          var link = event.target.closest && event.target.closest('a[href]'); if (!link) return;
          var href = link.getAttribute('href') || '';
          if (isLineUrl(href)) return sendLog('line_click', 'LINE');
          if (isExternalFormUrl(href)) { sendLog('form_link_click', 'フォーム'); link.href = appendAttributionToUrl(link.href); return; }
          if (href.toLowerCase().indexOf('tel:') === 0) sendLog('phone_click', '電話');
        } catch (err) {}
      }, true);
    }

    initAttribution();
    visitorId();
    sendLog('page_view', 'site');
    bindClicks();
    window.aokiAnalytics = {
      source: function() { return attribution().source || '不明'; },
      firstSeenAt: function() { return safeGet(STORAGE_FIRST_SEEN); },
      landingPage: function() { return safeGet(STORAGE_LANDING_PAGE) || pageUrl(); },
      logInteraction: sendLog
    };
  } catch (err) {}
})();
