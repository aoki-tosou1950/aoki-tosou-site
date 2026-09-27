'use strict';

const { GoogleAuth } = require('google-auth-library');
const { formatMediaSource } = require('./line');

const CACHE_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 1000;
// Allow a scale-to-zero Cloud Run instance to cold-start without paying for
// minimum instances. LINE notification may wait a few seconds, then keeps the
// existing raw-code fallback if the lookup is still unavailable.
const DEADLINE_MS = 5000;

function createMediaLabelResolver({ loadLabels, now = Date.now, cacheMs = CACHE_MS,
  retryMs = RETRY_MS, deadlineMs = DEADLINE_MS }) {
  let labels = null;
  let validUntil = 0;
  let retryAt = 0;
  let loading = null;

  async function boundedLoad() {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(loadLabels),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('media lookup timeout')), deadlineMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return async function mediaDisplay(source) {
    const fallback = formatMediaSource(source);
    if (fallback === '直接・不明') return fallback;
    const time = now();
    if (labels && time < validUntil) {
      return Object.hasOwn(labels, fallback) ? labels[fallback] :
        '未登録の媒体（' + fallback + '）';
    }
    if (time < retryAt) return fallback;
    if (!loading) {
      loading = boundedLoad().then(candidate => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
          throw new Error('invalid media lookup response');
        const safe = Object.create(null);
        for (const [code, label] of Object.entries(candidate)) {
          if (!/^[A-Za-z0-9_-]{1,50}$/.test(code) ||
              typeof label !== 'string' || !label.trim() ||
              label.length > 80 || /[\r\n]/.test(label)) throw new Error('invalid media label');
          safe[code] = label;
        }
        labels = safe;
        validUntil = now() + cacheMs;
        return safe;
      }).catch(() => {
        labels = null;
        retryAt = now() + retryMs;
        return null;
      }).finally(() => { loading = null; });
    }
    const current = await loading;
    if (!current) return fallback;
    return Object.hasOwn(current, fallback) ? current[fallback] :
      '未登録の媒体（' + fallback + '）';
  };
}

const auth = new GoogleAuth();
const mediaDisplay = createMediaLabelResolver({
  loadLabels: async () => {
    const rawUrl = process.env.MEDIA_LABELS_URL;
    if (!rawUrl) throw new Error('MEDIA_LABELS_URL missing');
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') throw new Error('invalid lookup URL');
    const client = await auth.getIdTokenClient(url.origin);
    const response = await client.request({
      url: url.origin + '/media-labels',
      timeout: DEADLINE_MS - 100
    });
    return response.data && response.data.labels;
  }
});

module.exports = { createMediaLabelResolver, mediaDisplay, CACHE_MS, RETRY_MS, DEADLINE_MS };
