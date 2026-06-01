(function() {
  try {
    var LOG_ENDPOINT = 'https://us-central1-aokitosou-miniapp.cloudfunctions.net/logInteraction';
    var STORAGE_SOURCE = 'aoki_analytics_source';
    var STORAGE_FIRST_SEEN = 'aoki_analytics_first_seen_at';
    var STORAGE_LANDING_PAGE = 'aoki_analytics_landing_page';

    function nowIso() {
      return new Date().toISOString();
    }

    function safeGet(key) {
      try {
        return window.localStorage.getItem(key) || '';
      } catch (err) {
        return '';
      }
    }

    function safeSet(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (err) {
        // Ignore storage failures so normal navigation always continues.
      }
    }

    function getFromParam() {
      try {
        return new URLSearchParams(window.location.search).get('from') || '';
      } catch (err) {
        return '';
      }
    }

    function currentPage() {
      return window.location.href;
    }

    function referrer() {
      return document.referrer || '';
    }

    function initAttribution() {
      var from = getFromParam();
      if (from) {
        safeSet(STORAGE_SOURCE, from);
        if (!safeGet(STORAGE_FIRST_SEEN)) {
          safeSet(STORAGE_FIRST_SEEN, nowIso());
        }
        if (!safeGet(STORAGE_LANDING_PAGE)) {
          safeSet(STORAGE_LANDING_PAGE, currentPage());
        }
      }
    }

    function source() {
      return safeGet(STORAGE_SOURCE) || '不明';
    }

    function landingPage() {
      return safeGet(STORAGE_LANDING_PAGE) || currentPage();
    }

    function firstSeenAt() {
      return safeGet(STORAGE_FIRST_SEEN);
    }

    function payload(eventType, contactChannel) {
      return {
        event_type: eventType,
        contact_channel: contactChannel,
        source: source(),
        landing_page: landingPage(),
        current_page: currentPage(),
        referrer: referrer()
      };
    }

    function sendLog(eventType, contactChannel) {
      try {
        var body = JSON.stringify(payload(eventType, contactChannel));

        if (navigator.sendBeacon) {
          try {
            var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
            if (navigator.sendBeacon(LOG_ENDPOINT, blob)) {
              return;
            }
          } catch (err) {
            // Fall through to fetch keepalive.
          }
        }

        if (window.fetch) {
          fetch(LOG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body,
            keepalive: true
          }).catch(function() {});
        }
      } catch (err) {
        // Logging must never block LINE, form, or phone actions.
      }
    }

    function isLineUrl(href) {
      try {
        var parsed = new URL(href, window.location.href);
        return parsed.hostname === 'line.me' || parsed.hostname.slice(-8) === '.line.me';
      } catch (err) {
        return false;
      }
    }

    function isExternalFormUrl(href) {
      try {
        var parsed = new URL(href, window.location.href);
        return parsed.href.indexOf('https://aokitosou-miniapp.web.app/inquiry-other.html') === 0
          || parsed.href.indexOf('https://aokitosou-miniapp.web.app/index.html') === 0;
      } catch (err) {
        return false;
      }
    }

    function appendAttributionToUrl(url) {
      try {
        var parsed = new URL(url, window.location.href);
        var storedSource = safeGet(STORAGE_SOURCE);
        var storedFirstSeen = firstSeenAt();
        var storedLandingPage = landingPage();

        if (storedSource && !parsed.searchParams.get('from')) {
          parsed.searchParams.set('from', storedSource);
        }
        if (storedFirstSeen && !parsed.searchParams.get('first_seen_at')) {
          parsed.searchParams.set('first_seen_at', storedFirstSeen);
        }
        if (storedLandingPage && !parsed.searchParams.get('landing_page')) {
          parsed.searchParams.set('landing_page', storedLandingPage);
        }

        return parsed.toString();
      } catch (err) {
        return url;
      }
    }

    function bindClicks() {
      document.addEventListener('click', function(event) {
        try {
          var link = event.target.closest && event.target.closest('a[href]');
          if (!link) return;

          var href = link.getAttribute('href') || '';

          if (isLineUrl(href)) {
            sendLog('line_click', 'LINE');
            return;
          }

          if (isExternalFormUrl(href)) {
            sendLog('form_link_click', 'フォーム');
            link.href = appendAttributionToUrl(link.href);
            return;
          }

          if (href.indexOf('tel:') === 0) {
            sendLog('phone_click', '電話');
          }
        } catch (err) {
          // Ignore per-click errors so the user's action continues.
        }
      }, true);
    }

    initAttribution();
    bindClicks();

    window.aokiAnalytics = {
      source: source,
      firstSeenAt: firstSeenAt,
      landingPage: landingPage,
      logInteraction: sendLog
    };
  } catch (err) {
    // Analytics is optional and must never affect page rendering.
  }
})();
