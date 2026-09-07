'use strict';

const crypto = require('crypto');

const JST_TIME_ZONE = 'Asia/Tokyo';
const COUNTER_NAMES = Object.freeze([
  'visitors',
  'pageViews',
  'lineClicks',
  'phoneClicks',
  'inquirySubmits',
  'lineFollows',
  'lineUnfollows',
  'inquiries',
  'surveys',
  'estimates',
  'orders'
]);

const PUBLIC_EVENT_COUNTERS = Object.freeze({
  page_view: 'pageViews',
  line_click: 'lineClicks',
  phone_click: 'phoneClicks'
});

// v1本番smoke（2026-08-29 JST）で記録済みの、識別可能な計測だけを
// 経営集計から除外する。元イベント・日次総数は監査用に残す。
const LEGACY_TEST_EXCLUSIONS = Object.freeze({
  '2026-08-29': Object.freeze({
    metrics: Object.freeze({
      visitors: 2,
      pageViews: 3,
      lineClicks: 1,
      phoneClicks: 1,
      inquirySubmits: 1,
      lineFollows: 1,
      lineUnfollows: 1
    }),
    sources: Object.freeze({
      production_smoke: Object.freeze({ visitors: 1, pageViews: 1, lineClicks: 1 }),
      codex_browser_smoke: Object.freeze({ visitors: 1, pageViews: 2, lineClicks: 0 })
    })
  })
});

function emptyMetrics() {
  return COUNTER_NAMES.reduce((result, name) => {
    result[name] = 0;
    return result;
  }, {});
}

function integer(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function jstDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateKeyToUtc(value) {
  if (!isDateKey(value)) throw new Error('Invalid date key');
  return new Date(`${value}T00:00:00.000Z`);
}

function shiftDateKey(value, days) {
  const date = dateKeyToUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function periodBounds(period, now = new Date()) {
  const today = jstDateKey(now);
  const [year, month, day] = today.split('-').map(Number);
  if (period === 'lastMonth') {
    const currentStart = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(currentStart);
    end.setUTCDate(0);
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  if (period === 'thisWeek') {
    const current = dateKeyToUtc(today);
    const mondayOffset = (current.getUTCDay() + 6) % 7;
    return { start: shiftDateKey(today, -mondayOffset), end: today };
  }
  return {
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: today
  };
}

function normalizeLabel(value, fallback = '不明') {
  const text = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
  return text || fallback;
}

function sourceKey(label) {
  return crypto.createHash('sha256').update(normalizeLabel(label)).digest('hex').slice(0, 16);
}

function normalizeEvent(body) {
  const eventType = String(body && body.event_type || '').trim();
  if (!Object.prototype.hasOwnProperty.call(PUBLIC_EVENT_COUNTERS, eventType) &&
      !['landing_page_view', 'form_link_click'].includes(eventType)) {
    throw new Error('Unsupported event_type');
  }
  const eventId = String(body && body.event_id || '').trim();
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(eventId)) throw new Error('Invalid event_id');
  const visitorId = String(body && body.visitor_id || '').trim();
  if (eventType === 'page_view' && !/^[A-Za-z0-9_-]{16,100}$/.test(visitorId)) {
    throw new Error('Invalid visitor_id');
  }
  return {
    eventType,
    eventId,
    visitorId,
    counter: PUBLIC_EVENT_COUNTERS[eventType] || '',
    source: normalizeLabel(body && body.source),
    // 2026-08-31追加（集客ファネル知性化）：クライアント（js/analytics.js）は既に
    // fromパラメータの生値をpayload().fromとして毎回送信していたが、サーバー側は
    // これまで受け取っていなかった（source列がfrom値を吸収して兼用していたため）。
    // Web参照元（direct/検索エンジン等）と青木塗装側で付与した媒体識別（チラシ・QR等）は
    // 意味が異なり両方を保持したいとの要望を受け、fromの生値をそのまま追加で保存する。
    // クライアント側の変更は不要（既存送信値を読むだけ）。新しい流入識別体系は作らない
    // （媒体名への変換は既存の媒体コードマスタ側＝GAS側で行う。ここでは生コードのまま）。
    from: String(body && body.from || '').trim().slice(0, 100),
    currentPage: String(body && body.current_page || '').trim().slice(0, 500),
    landingPage: String(body && body.landing_page || '').trim().slice(0, 500),
    referrer: String(body && body.referrer || '').trim().slice(0, 500),
    contactChannel: String(body && body.contact_channel || '').trim().slice(0, 30),
    testRequested: Boolean(body && body.test_event === true),
    isTest: false
  };
}

function isAuthorizedTestEvent(testRequested, authorization, expectedToken) {
  return Boolean(testRequested) && authorizeBearer(authorization, expectedToken);
}

function isLineTestEvent(event) {
  return Boolean(event && /^smoke_[A-Za-z0-9_-]{6,94}$/.test(String(event.webhookEventId || '')));
}

function visitorHash(day, visitorId) {
  return crypto.createHash('sha256').update(`${day}:${visitorId}`).digest('hex');
}

function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!Buffer.isBuffer(rawBody) || !signature || !channelSecret) return false;
  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const received = Buffer.from(String(signature));
  const calculated = Buffer.from(expected);
  return received.length === calculated.length && crypto.timingSafeEqual(received, calculated);
}

function authorizeBearer(header, expectedToken) {
  if (!expectedToken) return false;
  const match = String(header || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const received = Buffer.from(match[1]);
  const expected = Buffer.from(String(expectedToken));
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function normalizeSalesDays(days) {
  if (!Array.isArray(days) || days.length > 400) throw new Error('days must be an array of at most 400 items');
  const seen = new Set();
  return days.map((row) => {
    const date = String(row && row.date || '');
    if (!isDateKey(date) || seen.has(date)) throw new Error('Invalid or duplicate sales date');
    seen.add(date);
    return {
      date,
      inquiries: integer(row.inquiries),
      surveys: integer(row.surveys),
      estimates: integer(row.estimates),
      orders: integer(row.orders)
    };
  });
}

function aggregateRows(siteRows, salesRows) {
  const metrics = emptyMetrics();
  const excludedTestMetrics = emptyMetrics();
  const sources = {};
  (siteRows || []).forEach((row) => {
    const legacy = LEGACY_TEST_EXCLUSIONS[String(row && row.date || '')] || {};
    COUNTER_NAMES.forEach((name) => {
      if (!['inquiries', 'surveys', 'estimates', 'orders'].includes(name)) {
        const total = integer(row && row.metrics && row.metrics[name]);
        const excluded = Math.min(total, integer(row && row.testMetrics && row.testMetrics[name]) + integer(legacy.metrics && legacy.metrics[name]));
        metrics[name] += total - excluded;
        excludedTestMetrics[name] += excluded;
      }
    });
    Object.entries(row && row.sources || {}).forEach(([key, source]) => {
      const label = normalizeLabel(source && source.label);
      const testSource = row && row.testSources && row.testSources[key] || {};
      const legacySource = legacy.sources && legacy.sources[label] || {};
      if (!sources[label]) sources[label] = { source: label, visitors: 0, pageViews: 0, lineClicks: 0 };
      ['visitors', 'pageViews', 'lineClicks'].forEach((name) => {
        const total = integer(source && source[name]);
        const excluded = Math.min(total, integer(testSource && testSource[name]) + integer(legacySource && legacySource[name]));
        sources[label][name] += total - excluded;
      });
    });
  });
  (salesRows || []).forEach((row) => {
    ['inquiries', 'surveys', 'estimates', 'orders'].forEach((name) => {
      metrics[name] += integer(row && row[name]);
    });
  });
  const topSources = Object.values(sources)
    .filter((source) => source.visitors > 0 || source.pageViews > 0 || source.lineClicks > 0)
    .sort((a, b) => b.visitors - a.visitors || b.pageViews - a.pageViews || a.source.localeCompare(b.source, 'ja'))
    .slice(0, 8);
  return { metrics, topSources, excludedTestMetrics };
}

function conversionRate(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function dashboardPayload(bounds, siteRows, salesRows, lineInsight) {
  const aggregate = aggregateRows(siteRows, salesRows);
  const m = aggregate.metrics;
  const stages = [
    ['visitors', 'サイト訪問'],
    ['lineClicks', 'LINEクリック'],
    ['lineFollows', 'LINE新規友だち'],
    ['inquiries', '問い合わせ'],
    ['surveys', '現調'],
    ['estimates', '見積'],
    ['orders', '受注']
  ].map(([key, label], index, all) => ({
    key,
    label,
    value: m[key],
    conversionRate: index === 0 ? null : conversionRate(m[key], m[all[index - 1][0]])
  }));
  return {
    period: bounds,
    generatedAt: new Date().toISOString(),
    metrics: m,
    excludedTestMetrics: aggregate.excludedTestMetrics,
    stages,
    topSources: aggregate.topSources,
    lineInsight: lineInsight || { available: false, reason: 'LINE統計未取得' }
  };
}

function createFunnelStore(db) {
  function currentDailyData(snapshot, day) {
    const data = snapshot.exists ? snapshot.data() : {};
    return {
      date: day,
      metrics: Object.assign({}, data.metrics || {}),
      testMetrics: Object.assign({}, data.testMetrics || {}),
      sources: Object.assign({}, data.sources || {}),
      testSources: Object.assign({}, data.testSources || {})
    };
  }

  async function recordWebEvent(event, now = new Date()) {
    if (!event.counter) return { recorded: false, reason: 'legacy_event' };
    const day = jstDateKey(now);
    const dayRef = db.collection('funnel_daily').doc(day);
    const eventRef = dayRef.collection('events').doc(event.eventId);
    const dailyVisitorRef = event.eventType === 'page_view'
      ? dayRef.collection('visitors').doc(visitorHash(day, event.isTest ? `test:${event.visitorId}` : event.visitorId))
      : null;
    return db.runTransaction(async (transaction) => {
      const daySnapshot = await transaction.get(dayRef);
      const eventSnapshot = await transaction.get(eventRef);
      const visitorSnapshot = dailyVisitorRef ? await transaction.get(dailyVisitorRef) : null;
      if (eventSnapshot.exists) return { recorded: false, duplicate: true };
      const daily = currentDailyData(daySnapshot, day);
      const key = sourceKey(event.source);
      const source = Object.assign({ label: event.source, visitors: 0, pageViews: 0, lineClicks: 0 }, daily.sources[key] || {});
      const testSource = Object.assign({ label: event.source, visitors: 0, pageViews: 0, lineClicks: 0 }, daily.testSources[key] || {});
      daily.metrics[event.counter] = Number(daily.metrics[event.counter] || 0) + 1;
      if (event.isTest) daily.testMetrics[event.counter] = Number(daily.testMetrics[event.counter] || 0) + 1;
      if (event.eventType === 'page_view') source.pageViews += 1;
      if (event.eventType === 'line_click') source.lineClicks += 1;
      if (event.isTest && event.eventType === 'page_view') testSource.pageViews += 1;
      if (event.isTest && event.eventType === 'line_click') testSource.lineClicks += 1;
      if (dailyVisitorRef && !visitorSnapshot.exists) {
        daily.metrics.visitors = Number(daily.metrics.visitors || 0) + 1;
        source.visitors += 1;
        if (event.isTest) {
          daily.testMetrics.visitors = Number(daily.testMetrics.visitors || 0) + 1;
          testSource.visitors += 1;
        }
        transaction.create(dailyVisitorRef, { isTest: Boolean(event.isTest), createdAt: now });
      }
      daily.sources[key] = source;
      if (event.isTest) daily.testSources[key] = testSource;
      transaction.set(dayRef, Object.assign(daily, { updatedAt: now }), { merge: true });
      transaction.create(eventRef, { eventType: event.eventType, source: event.source, isTest: Boolean(event.isTest), createdAt: now });
      return { recorded: true, visitorAdded: Boolean(dailyVisitorRef && !visitorSnapshot.exists) };
    });
  }

  async function recordInternalMetric(counter, eventId, source, now = new Date(), isTest = false) {
    const day = jstDateKey(now);
    const dayRef = db.collection('funnel_daily').doc(day);
    const eventRef = dayRef.collection('events').doc(eventId);
    return db.runTransaction(async (transaction) => {
      const daySnapshot = await transaction.get(dayRef);
      const eventSnapshot = await transaction.get(eventRef);
      if (eventSnapshot.exists) return false;
      const daily = currentDailyData(daySnapshot, day);
      daily.metrics[counter] = Number(daily.metrics[counter] || 0) + 1;
      if (isTest) daily.testMetrics[counter] = Number(daily.testMetrics[counter] || 0) + 1;
      transaction.set(dayRef, Object.assign(daily, { updatedAt: now }), { merge: true });
      transaction.create(eventRef, { eventType: counter, source: normalizeLabel(source), isTest: Boolean(isTest), createdAt: now });
      return true;
    });
  }

  async function recordLineEvent(event) {
    if (!event || !['follow', 'unfollow'].includes(event.type)) return false;
    const eventId = String(event.webhookEventId || '').trim().slice(0, 100);
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(eventId)) throw new Error('Invalid webhookEventId');
    const occurredAt = new Date(Number(event.timestamp));
    const now = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
    const day = jstDateKey(now);
    const dayRef = db.collection('funnel_daily').doc(day);
    const eventRef = dayRef.collection('line_events').doc(eventId);
    const counter = event.type === 'follow' ? 'lineFollows' : 'lineUnfollows';
    const isTest = isLineTestEvent(event);
    return db.runTransaction(async (transaction) => {
      const daySnapshot = await transaction.get(dayRef);
      const eventSnapshot = await transaction.get(eventRef);
      if (eventSnapshot.exists) return false;
      const daily = currentDailyData(daySnapshot, day);
      daily.metrics[counter] = Number(daily.metrics[counter] || 0) + 1;
      if (isTest) daily.testMetrics[counter] = Number(daily.testMetrics[counter] || 0) + 1;
      transaction.set(dayRef, Object.assign(daily, { updatedAt: new Date() }), { merge: true });
      transaction.create(eventRef, { type: event.type, isTest, occurredAt: now, createdAt: new Date() });
      return true;
    });
  }

  return { recordInternalMetric, recordLineEvent, recordWebEvent };
}

/* ============================================================================
 * ドリルダウン（2026-08-30追加）：AOKI OSダッシュボード共通原則「集計数字は根拠データ
 * まで降りられること」への対応。getFunnelDashboardの集計値（aggregateRows）と必ず
 * 一致するよう、同じLEGACY_TEST_EXCLUSIONS・同じis_testフラグ判定を根拠一覧側でも
 * 適用する（集計と一覧で別々の除外ロジックを作らない）。
 * ============================================================================ */

const DRILLDOWN_EVENT_TYPES = Object.freeze({
  visitors: 'page_view',
  lineClicks: 'line_click',
  phoneClicks: 'phone_click'
});
const DRILLDOWN_DAILY_METRICS = Object.freeze(['lineFollows', 'lineUnfollows']);

/* ----------------------------------------------------------------------------
 * 表示用の人間翻訳（2026-08-31追加）：ドリルダウンの生ログ（event_type・source文字列・
 * URL）を、営業・経営者が読める日本語へ変換する。ここに列挙した値は以下のいずれかで
 * 実在確認済みのものだけであり、存在しない/未確認のページ名・流入元名を推測で作らない
 * （未知の値は素通し、または「不明」と明示する）。
 * - KNOWN_PAGES: 本番サイトの実際のsitemap.xml（aoki-tosou.net）と、フォーム側ドメイン
 *   （aokitosou-miniapp.web.app）の実ページを直接取得し、<title>から確認したページ名。
 * - KNOWN_MEDIA_SOURCES: analytics.md §2（正本）のfromパラメータ一覧に定義済みの値。
 * - KNOWN_REFERRER_HOSTS: 検索エンジン・SNS等の一般に知られたドメイン名の日本語表記。
 * ---------------------------------------------------------------------------- */
const KNOWN_PAGES = Object.freeze({
  'aoki-tosou.net/': 'トップページ',
  'aoki-tosou.net': 'トップページ',
  'aoki-tosou.net/works.html': '施工事例',
  'aoki-tosou.net/faq.html': 'よくある質問',
  'aoki-tosou.net/about.html': '会社案内',
  'aokitosou-miniapp.web.app/': '現地調査依頼フォーム',
  'aokitosou-miniapp.web.app': '現地調査依頼フォーム',
  'aokitosou-miniapp.web.app/line-consult.html': '写真でかんたん相談（LINE）',
  'aokitosou-miniapp.web.app/inquiry-other.html': 'その他のご依頼フォーム'
});
const KNOWN_MEDIA_SOURCES = Object.freeze({
  flyer_general_v1: 'チラシ（汎用版）',
  meishi: '名刺',
  meishi_v1: '名刺',
  syaki_v1: '社旗',
  web_cta_v1: 'サイト内CTAボタン',
  line_richmenu_consult_v1: 'LINEリッチメニュー（LINE相談）'
});
const KNOWN_REFERRER_HOSTS = Object.freeze({
  'search.yahoo.co.jp': 'Yahoo!検索',
  'yahoo.co.jp': 'Yahoo!検索',
  'google.com': 'Google検索',
  'google.co.jp': 'Google検索',
  'bing.com': 'Bing検索',
  'facebook.com': 'Facebook',
  'l.facebook.com': 'Facebook',
  'lm.facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'l.instagram.com': 'Instagram',
  't.co': 'X（旧Twitter）',
  'twitter.com': 'X（旧Twitter）',
  'x.com': 'X（旧Twitter）',
  'line.me': 'LINE',
  'aoki-tosou.net': '自社サイト内',
  'aokitosou-miniapp.web.app': '自社サイト内'
});

function hostnameOf_(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase();
  } catch (err) { return ''; }
}
function pageKeyOf_(url) {
  try {
    const u = new URL(String(url || ''));
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    return host + (u.pathname || '/');
  } catch (err) { return ''; }
}
/** URLを人間向けページ名へ変換する。KNOWN_PAGESに実在確認済みの値が無い場合は
 * label:nullとし、生のpath（例: "/faq.html"）だけを返す（存在しないページ名を作らない）。 */
function humanizePage_(url) {
  const raw = String(url || '');
  if (!raw) return { label: null, path: '' };
  const key = pageKeyOf_(raw);
  const label = Object.prototype.hasOwnProperty.call(KNOWN_PAGES, key) ? KNOWN_PAGES[key] : null;
  let path = raw;
  try { const u = new URL(raw); path = u.pathname || '/'; } catch (err) { /* そのまま */ }
  return { label, path };
}
/** source（fromコード／direct／internal／不明／参照元ホスト等）を人間向けの流入元表現へ
 * 変換する。sourceだけで判断できない場合のみ、実際に記録済みのreferrer値から追加で
 * 判定する（referrerが無ければ「流入元不明」と明示し、推測しない）。 */
function humanizeSource_(source, referrer) {
  const s = normalizeLabel(source);
  if (s === 'direct') return { label: '直接アクセス', detail: 'URLを直接入力、またはブックマークから' };
  if (s === 'internal') return { label: 'サイト内の他ページから', detail: null };
  if (Object.prototype.hasOwnProperty.call(KNOWN_MEDIA_SOURCES, s)) return { label: KNOWN_MEDIA_SOURCES[s], detail: null };
  const lower = s.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KNOWN_REFERRER_HOSTS, lower)) return { label: KNOWN_REFERRER_HOSTS[lower], detail: null };
  if (s === '不明' || !s) {
    const refHost = hostnameOf_(referrer);
    if (refHost && Object.prototype.hasOwnProperty.call(KNOWN_REFERRER_HOSTS, refHost)) {
      return { label: KNOWN_REFERRER_HOSTS[refHost], detail: null };
    }
    if (refHost) return { label: refHost, detail: '参照元サイト（表示名は未登録）' };
    return { label: '流入元不明', detail: null };
  }
  // 未登録の媒体コード等はそのまま表示する（社内で管理している値であり、意味を持つため）。
  return { label: s, detail: null };
}

/**
 * Web参照元（Google/Yahoo/direct等）だけを、fromコード（媒体識別）とは独立に判定する
 * （2026-08-31追加：集客ファネル知性化）。「青木塗装が付与した媒体識別」と「訪問者の
 * ブラウザが実際に報告したリファラー」は意味が異なるため、humanizeSource_（from優先の
 * 表示）とは別に、referrerフィールドだけを見て判定する軸を用意する。判定できない
 * （リファラーが空＝直接アクセス/アプリ内ブラウザ等）場合はlabel:nullを返し、
 * 「不明」等を推測で作らない（呼び出し側はnullなら行自体を表示しない）。
 */
function humanizeReferrer_(referrer) {
  const host = hostnameOf_(referrer);
  if (!host) return { label: null };
  if (Object.prototype.hasOwnProperty.call(KNOWN_REFERRER_HOSTS, host)) {
    return { label: KNOWN_REFERRER_HOSTS[host] };
  }
  return { label: host, detail: '参照元サイト（表示名は未登録）' };
}

/** ページのURL（KNOWN_PAGESで確認済みのpageKey）から、見込み度ルールで使う
 * カテゴリだけを判定する（2026-08-31追加）。施工事例・FAQ・現調/相談導線
 * （ミニアプリ側ドメインは全ページがこの導線）の3種類のみ。それ以外はnull。
 * 新しいページ名を推測しない＝KNOWN_PAGESに実在確認済みのkeyのみ対象。 */
const WORKS_PAGE_KEY = 'aoki-tosou.net/works.html';
const FAQ_PAGE_KEY = 'aoki-tosou.net/faq.html';
const SURVEY_HOST = 'aokitosou-miniapp.web.app';
function pageCategoryOf_(pageKey) {
  if (!pageKey) return null;
  if (pageKey === WORKS_PAGE_KEY) return 'works';
  if (pageKey === FAQ_PAGE_KEY) return 'faq';
  if (pageKey.indexOf(SURVEY_HOST) === 0) return 'survey';
  return null;
}

/** 2つのJST日付キー（YYYY-MM-DD）の日数差を計算する（2026-08-31追加）。 */
function daysBetweenDateKeys_(fromKey, toKey) {
  return Math.round((dateKeyToUtc(toKey) - dateKeyToUtc(fromKey)) / 86400000);
}

/**
 * 匿名訪問の見込み度を、明示的なルールベースで判定する（2026-08-31追加：集客ファネル
 * 知性化）。AIの雰囲気判定は使わない。各ルールは重み付き加点で、なぜその見込み度に
 * なったかを人間が読める理由（reasons）としてそのまま返す。「競合」「施主」等の
 * 人物属性は行動データだけでは断定できないため一切判定しない。
 * 戻り値: { level:'高'|'中'|'低', score:number, reasons:string[] }
 * - 高: score>=55 / 中: score>=20 / それ以外は低（0点＝反応なしも「低」＝見えている
 *   行動が乏しいだけで、行動自体が観測できないpage_view無しの反応とは区別する。
 *   page_view無しのケース（visitPageCount==null）はこの関数を呼ばず、呼び出し側が
 *   level:'判定不能'を直接返す＝推測しない）。
 */
function computeLeadScore_(visit, priorVisit) {
  const reasons = [];
  let score = 0;
  const actions = visit.actions || [];
  const hasLine = actions.some((a) => a.type === 'lineClick');
  const hasPhone = actions.some((a) => a.type === 'phoneClick');
  if (hasLine) { score += 40; reasons.push('LINEクリック'); }
  if (hasPhone) { score += 40; reasons.push('電話タップ'); }
  const categories = (visit.pageCategories || []);
  const worksCount = categories.filter((c) => c === 'works').length;
  const faqCount = categories.filter((c) => c === 'faq').length;
  const surveyCount = categories.filter((c) => c === 'survey').length;
  if (surveyCount > 0) { score += 25; reasons.push('現調・相談導線閲覧'); }
  if (worksCount > 0) { score += 15 * Math.min(worksCount, 2); reasons.push('施工事例' + worksCount + '件閲覧'); }
  if (faqCount > 0) { score += 10; reasons.push('FAQ閲覧'); }
  const pageCount = visit.pageCount || 0;
  if (pageCount >= 4) { score += 15; reasons.push('閲覧深度4ページ以上'); }
  else if (pageCount >= 3) { score += 10; reasons.push('閲覧深度3ページ以上'); }
  const revisit = { isReturning: false, daysSincePrevious: null, deeperThanPrevious: false, strongerReactionThanPrevious: false };
  if (priorVisit) {
    revisit.isReturning = true;
    revisit.daysSincePrevious = daysBetweenDateKeys_(priorVisit.dayKey, visit.dayKey);
    score += 15; reasons.push('再訪（前回から' + revisit.daysSincePrevious + '日）');
    if (pageCount > priorVisit.pageCount) { revisit.deeperThanPrevious = true; score += 10; reasons.push('前回より深い閲覧'); }
    const hadActionNow = hasLine || hasPhone;
    if (hadActionNow && !priorVisit.hadAction) { revisit.strongerReactionThanPrevious = true; score += 15; reasons.push('前回より強い反応'); }
  }
  const level = score >= 55 ? '高' : (score >= 20 ? '中' : '低');
  return { level, score, reasons, revisit };
}

/** visitor_id（クライアントのlocalStorageに保存された乱数トークン）から、復元不可能な
 * 短い表示用トークンを作る。生のvisitor_idは呼び出し元へも一覧へも一切渡さない。 */
function visitorToken(visitorId) {
  const value = String(visitorId || '').trim();
  if (!value) return '';
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
}

/** そのinteraction_logsドキュメントが、既知のスモークテスト由来（LEGACY_TEST_EXCLUSIONS
 * に列挙された日付・source）かどうかを判定する。is_testフラグ（2026-08-30以降の新しい
 * イベントに付与）とは別に、2026-08-29分の旧イベント（is_testフラグが無い）を除外するため
 * に必要。集計側（aggregateRows）のsources除外と同じ判定基準を使う。 */
function isLegacyExcludedSource_(sourceLabel, dayKey) {
  const legacy = LEGACY_TEST_EXCLUSIONS[dayKey];
  if (!legacy || !legacy.sources) return false;
  return Object.prototype.hasOwnProperty.call(legacy.sources, normalizeLabel(sourceLabel));
}

/** funnel_dailyの1日分ドキュメントから、指定カウンタの「実績（除外済み）」件数を、
 * aggregateRowsと完全に同じ式（total - min(total, test+legacy)）で計算する。 */
function realDailyCount_(dayData, counterName) {
  const total = integer(dayData && dayData.metrics && dayData.metrics[counterName]);
  const testCount = integer(dayData && dayData.testMetrics && dayData.testMetrics[counterName]);
  const legacyCount = integer(LEGACY_TEST_EXCLUSIONS[dayData && dayData.date] &&
    LEGACY_TEST_EXCLUSIONS[dayData.date].metrics && LEGACY_TEST_EXCLUSIONS[dayData.date].metrics[counterName]);
  const excluded = Math.min(total, testCount + legacyCount);
  return total - excluded;
}

/** interaction_logs（page_view/line_click/phone_click）を[startAt,endAt)で取得し、
 * is_test・LEGACY_TEST_EXCLUSIONSを適用済みの行配列を返す共通ヘルパー
 * （2026-08-31追加：funnelDrilldown/funnelInsights/funnelRecentActivityで重複させない）。 */
async function loadInteractionRows_(db, startAt, endAt) {
  const snapshot = await db.collection('interaction_logs')
    .where('event_type', 'in', ['page_view', 'line_click', 'phone_click'])
    .where('created_at', '>=', startAt)
    .where('created_at', '<', endAt)
    .get();
  const rows = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    if (data.is_test) return;
    const createdAt = data.created_at && typeof data.created_at.toDate === 'function' ? data.created_at.toDate() : null;
    if (!createdAt) return;
    const dayKey = jstDateKey(createdAt);
    const source = normalizeLabel(data.source);
    if (isLegacyExcludedSource_(source, dayKey)) return;
    rows.push({
      eventType: String(data.event_type || ''),
      at: createdAt,
      dayKey,
      source,
      // 2026-08-31追加：媒体識別（from）はsourceと独立に保持する（無ければ空文字。
      // 2026-08-31より前に記録された行はfromフィールド自体が存在しないため必ず空になる
      // ＝旧データはWeb参照元ベースの表示へ自然にフォールバックする）。
      from: String(data.from || ''),
      currentPage: String(data.current_page || ''),
      referrer: String(data.referrer || ''),
      visitorHashValue: String(data.visitor_hash || '')
    });
  });
  return rows;
}

function visitKey_(dayKey, visitorHashValue) {
  return dayKey + ':' + (visitorHashValue || '(不明)');
}

/** page_view行を「日付＋visitor_hash」単位（visitors集計と同じ単位）でまとめ、
 * 各訪問へ流入元（from優先・無ければsource）・Web参照元・ページ内訳・
 * ページカテゴリ（見込み度判定用）を付与する（2026-08-31追加）。 */
function groupVisits_(rows) {
  const visitGroups = new Map();
  rows.filter((r) => r.eventType === 'page_view').forEach((row) => {
    const key = visitKey_(row.dayKey, row.visitorHashValue);
    if (!visitGroups.has(key)) visitGroups.set(key, []);
    visitGroups.get(key).push(row);
  });
  visitGroups.forEach((list) => list.sort((a, b) => a.at - b.at));
  return visitGroups;
}

/** 1訪問（同一key・同一日のpage_view配列）から、表示用サマリと見込み度判定用の
 * 内部情報（pageCategories等・クライアントへは返さない）を組み立てる（2026-08-31改訂）。 */
function buildVisitSummary_(pageViews, dayKey) {
  const first = pageViews[0];
  const mediaCode = first.from || '';
  const src = humanizeSource_(first.source, first.referrer);
  const referrerInfo = humanizeReferrer_(first.referrer);
  const pages = pageViews.map((p) => {
    const h = humanizePage_(p.currentPage);
    return { at: p.at.toISOString(), label: h.label, path: h.path };
  });
  const pageCategories = pageViews.map((p) => pageCategoryOf_(pageKeyOf_(p.currentPage)));
  return {
    at: first.at.toISOString(),
    dayKey,
    // mediaCodeが有る場合はGAS側（媒体コードマスタ）で表示名へ翻訳される前提の生値。
    // Firebase単体では翻訳せず、そのまま返す（新しい流入識別体系を作らないため
    // 既存マスタでの翻訳をGAS側に委ねる）。mediaCodeが無い場合はsourceLabel
    // （direct/参照元ホスト等、従来どおりFirebase側で翻訳済み）を使う。
    mediaCode,
    sourceLabel: mediaCode ? null : src.label,
    sourceDetail: mediaCode ? null : src.detail,
    referrerLabel: referrerInfo.label,
    referrerDetail: referrerInfo.detail || null,
    firstPage: pages[0] || null,
    pageCount: pages.length,
    pages,
    pageCategories
  };
}

/**
 * 指定日より前の来訪履歴（直近lookbackDays日）から、同一visitor_hashの「直前の訪問」を
 * 検索するための索引を作る（2026-08-31追加：再訪・見込み度の「前回より深い/強い」判定用）。
 * lookbackDaysを超えて遡らない＝存在しない再訪を推測しない（境界を超えた場合は
 * 呼び出し側が「isReturning不明」として扱う）。
 */
function buildPriorVisitIndex_(lookbackRows) {
  const byHash = new Map();
  const lookbackGroups = groupVisits_(lookbackRows);
  lookbackGroups.forEach((pageViews, key) => {
    const sepIdx = key.lastIndexOf(':');
    const dayKey = key.slice(0, sepIdx);
    const hashPart = key.slice(sepIdx + 1);
    if (hashPart === '(不明)') return; // visitor_hash不明の訪問は再訪判定の対象外（誤って同一人物と推測しない）
    const hadAction = lookbackRows.some((r) => r.eventType !== 'page_view' && r.dayKey === dayKey && r.visitorHashValue === hashPart);
    if (!byHash.has(hashPart)) byHash.set(hashPart, []);
    byHash.get(hashPart).push({ dayKey, pageCount: pageViews.length, hadAction });
  });
  byHash.forEach((list) => list.sort((a, b) => (a.dayKey < b.dayKey ? -1 : 1)));
  return byHash;
}

/** 指定visitorHash・指定日より前の直近の訪問を1件返す（無ければnull）（2026-08-31追加）。
 * priorIndexは同一期間内のより早い日の訪問（inPeriodPriorList）も含めて検索する。 */
function findPriorVisit_(priorIndex, visitorHash, beforeDayKey, inPeriodPriorList) {
  const combined = (priorIndex.get(visitorHash) || []).concat(inPeriodPriorList || []);
  const candidates = combined.filter((v) => v.dayKey < beforeDayKey).sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));
  return candidates[0] || null;
}

/**
 * rows・visitGroupsから、見込み度・再訪情報つきの訪問一覧を組み立てる共通処理
 * （2026-08-31追加）。funnelDrilldown（visitors）・funnelInsights・funnelRecentActivityの
 * 3箇所で同じ訪問には必ず同じ見込み度が付くよう、ロジックを1箇所にまとめる
 * （同一期間内でより早い日の訪問を「直前の訪問」として使う処理も含む）。
 * 戻り値の各要素はvisitorHashValue（内部識別子）を保持するが、これは同一訪問の
 * 反応（LINE/電話）を突き合わせるための内部使用のみで、呼び出し側が最終的に
 * クライアントへ返す前に明示的に除外する。
 */
function buildScoredVisits_(rows, visitGroups, priorIndex) {
  const inPeriodByHash = new Map();
  visitGroups.forEach((pageViews, key) => {
    const sepIdx = key.lastIndexOf(':');
    const dayKey = key.slice(0, sepIdx);
    const hashPart = key.slice(sepIdx + 1);
    if (hashPart === '(不明)') return;
    const hadAction = rows.some((r) => r.eventType !== 'page_view' && r.dayKey === dayKey && r.visitorHashValue === hashPart);
    if (!inPeriodByHash.has(hashPart)) inPeriodByHash.set(hashPart, []);
    inPeriodByHash.get(hashPart).push({ dayKey, pageCount: pageViews.length, hadAction });
  });
  return Array.from(visitGroups.entries()).map(([key, pageViews]) => {
    const sepIdx = key.lastIndexOf(':');
    const dayKey = key.slice(0, sepIdx);
    const visitorHashValue = key.slice(sepIdx + 1) === '(不明)' ? '' : key.slice(sepIdx + 1);
    const summary = buildVisitSummary_(pageViews, dayKey);
    const actions = rows
      .filter((r) => r.eventType !== 'page_view' && r.dayKey === dayKey && (r.visitorHashValue || '(不明)') === (visitorHashValue || '(不明)'))
      .sort((a, b) => a.at - b.at)
      .map((r) => ({ type: r.eventType === 'line_click' ? 'lineClick' : 'phoneClick', at: r.at.toISOString() }));
    const prior = visitorHashValue ? findPriorVisit_(priorIndex, visitorHashValue, dayKey, inPeriodByHash.get(visitorHashValue)) : null;
    const leadScore = computeLeadScore_(Object.assign({}, summary, { actions }), prior);
    return Object.assign({}, summary, { key, dayKey, visitorHashValue, actions, leadScore });
  }).sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** buildScoredVisits_の結果から、内部識別子（visitorHashValue・key・dayKey・
 * pageCategories）を除いたクライアント向けの訪問カードを組み立てる（2026-08-31追加）。 */
function visitToClientItem_(v) {
  return {
    at: v.at,
    mediaCode: v.mediaCode,
    sourceLabel: v.sourceLabel,
    sourceDetail: v.sourceDetail,
    referrerLabel: v.referrerLabel,
    referrerDetail: v.referrerDetail,
    firstPage: v.firstPage,
    pageCount: v.pageCount,
    pages: v.pages,
    actions: v.actions,
    leadScore: { level: v.leadScore.level, score: v.leadScore.score, reasons: v.leadScore.reasons, revisit: v.leadScore.revisit }
  };
}

/**
 * 指定期間・指定指標の根拠一覧を、営業・経営者が読める形で返す（2026-08-31改訂：
 * 生ログ形式から人間向け表示への翻訳／見込み度・再訪・媒体識別の付与）。
 * getFunnelDashboardのmetrics[metric]と件数が一致するよう、集計と同じ除外ルールを
 * ここでも適用する。visitor_id・visitor_hash等の内部識別子は戻り値に一切含めない
 * （グルーピングと再訪判定にのみ使う）。
 * - visitors（サイト訪問）: page_viewイベントを「日付＋visitor_hash」で1訪問に
 *   まとめる（visitors集計の定義＝同日同一訪問者は1件、と完全に一致させる）。
 *   1訪問＝流入元・Web参照元・最初に見たページ・閲覧ページの時系列・その訪問中の
 *   LINEクリック／電話タップ（あれば）・見込み度（理由付き）・再訪情報をまとめて返す。
 * - lineClicks / phoneClicks: 実イベント件数がそのまま集計値のため、行を間引かず
 *   1件＝1回のクリックとして返す。ただし同じ訪問（あれば）の流入元・閲覧ページ数・
 *   見込み度を文脈として添える（訪問が見つからない場合＝page_view記録の無い反応は
 *   見込み度を「判定不能」とし、存在しない閲覧文脈を捏造しない）。
 * - lineFollows / lineUnfollows: LINEの仕様上、個人・流入元は特定できないため、
 *   funnel_dailyの日別実績（除外済み）だけを日付単位で返す。
 */
const REVISIT_LOOKBACK_DAYS = 90;
async function funnelDrilldown(db, metric, bounds) {
  if (DRILLDOWN_DAILY_METRICS.indexOf(metric) >= 0) {
    const snapshot = await db.collection('funnel_daily')
      .where('date', '>=', bounds.start).where('date', '<=', bounds.end).get();
    const days = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      const count = realDailyCount_(data, metric);
      if (count > 0) days.push({ date: data.date, count });
    });
    days.sort((a, b) => (a.date < b.date ? 1 : -1));
    return {
      kind: 'lineDaily',
      metric,
      items: days,
      total: days.reduce((sum, d) => sum + d.count, 0),
      note: 'LINE公式アカウントの友だち増減は、LINEの仕様上、どなたが登録・解除したか（個人・流入元）を特定できません。日付ごとの純増数のみを表示しています。'
    };
  }

  const eventType = DRILLDOWN_EVENT_TYPES[metric];
  if (!eventType) throw new Error('Unsupported drilldown metric');
  const startAt = new Date(`${bounds.start}T00:00:00.000+09:00`);
  const endAt = new Date(`${shiftDateKey(bounds.end, 1)}T00:00:00.000+09:00`);
  const rows = await loadInteractionRows_(db, startAt, endAt);
  const visitGroups = groupVisits_(rows);

  // 再訪判定用：期間開始よりREVISIT_LOOKBACK_DAYS日前までのpage_view履歴を別途取得する
  // （期間より前の「直前の訪問」を探すため。境界を超える再訪は「不明」のまま扱う）。
  const lookbackStartAt = new Date(`${shiftDateKey(bounds.start, -REVISIT_LOOKBACK_DAYS)}T00:00:00.000+09:00`);
  const lookbackRows = await loadInteractionRows_(db, lookbackStartAt, startAt);
  const priorIndex = buildPriorVisitIndex_(lookbackRows);
  const scoredVisits = buildScoredVisits_(rows, visitGroups, priorIndex);

  if (metric === 'visitors') {
    const items = scoredVisits.map(visitToClientItem_);
    return { kind: 'visit', metric, items, total: items.length };
  }

  // lineClicks / phoneClicks: 実イベント件数＝集計値。行は間引かず、同じ訪問（あれば）の
  // 文脈（閲覧ページ数・見込み度）だけを添える。
  const scoredByKey = new Map(scoredVisits.map((v) => [v.key, v]));
  const items = rows
    .filter((r) => r.eventType === eventType)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map((row) => {
      const mediaCode = row.from || '';
      const src = humanizeSource_(row.source, row.referrer);
      const referrerInfo = humanizeReferrer_(row.referrer);
      const page = humanizePage_(row.currentPage);
      const visit = scoredByKey.get(visitKey_(row.dayKey, row.visitorHashValue));
      // page_view記録が無い反応（例：計測開始前後の手動バックフィル）は、存在しない
      // 閲覧文脈を捏造せず、見込み度を「判定不能」と明示する。
      const leadScore = visit ? visit.leadScore : { level: '判定不能', score: null, reasons: ['行動の前後にページ閲覧記録なし'], revisit: { isReturning: false, daysSincePrevious: null, deeperThanPrevious: false, strongerReactionThanPrevious: false } };
      return {
        at: row.at.toISOString(),
        mediaCode,
        sourceLabel: mediaCode ? null : src.label,
        sourceDetail: mediaCode ? null : src.detail,
        referrerLabel: referrerInfo.label,
        referrerDetail: referrerInfo.detail || null,
        pageLabel: page.label,
        pagePath: page.path,
        visitPageCount: visit ? visit.pageCount : null,
        leadScore
      };
    });
  return { kind: 'event', metric, items, total: items.length };
}

/**
 * 集客ファネルの「営業ファネル」タブ拡張（2026-08-31追加：集客ファネル知性化）向けの
 * 期間集計。個別訪問の一覧（funnelDrilldown）とは別に、期間全体を俯瞰する3つの分析
 * （見込み度の内訳／流入元別の質／離脱ポイント）をまとめて返す。visitor⇄INQ/J-IDの
 * 推測結合は一切行わない（獲得経路別の成約率は営業OS正本側の既存チャネル比較を使う）。
 */
async function funnelInsights(db, bounds) {
  const startAt = new Date(`${bounds.start}T00:00:00.000+09:00`);
  const endAt = new Date(`${shiftDateKey(bounds.end, 1)}T00:00:00.000+09:00`);
  const rows = await loadInteractionRows_(db, startAt, endAt);
  const visitGroups = groupVisits_(rows);
  const lookbackStartAt = new Date(`${shiftDateKey(bounds.start, -REVISIT_LOOKBACK_DAYS)}T00:00:00.000+09:00`);
  const lookbackRows = await loadInteractionRows_(db, lookbackStartAt, startAt);
  const priorIndex = buildPriorVisitIndex_(lookbackRows);
  const visits = buildScoredVisits_(rows, visitGroups, priorIndex);

  // (1) 見込み度の内訳。page_view記録の無い反応（line_click/phone_clickのみ）も
  // 「判定不能」として同じ内訳に含める（存在しない閲覧文脈を捏造しない）。
  const leadScoreBreakdown = { 高: 0, 中: 0, 低: 0, 判定不能: 0 };
  visits.forEach((v) => { leadScoreBreakdown[v.leadScore.level] += 1; });
  const visitKeysSet = new Set(Array.from(visitGroups.keys()));
  rows.filter((r) => r.eventType !== 'page_view').forEach((r) => {
    if (visitKeysSet.has(visitKey_(r.dayKey, r.visitorHashValue))) return; // 訪問側で既に加算済み
    leadScoreBreakdown.判定不能 += 1;
  });

  // (2) 流入元別の質。表示ラベルは媒体コード優先（mediaCodeがある場合はGAS側で
  // 翻訳される前提でmediaCodeをキーにする）、無ければWeb参照元ベースのsourceLabelを使う。
  const bySource = new Map();
  function sourceGroupKey_(mediaCode, sourceLabel) {
    return mediaCode ? ('media:' + mediaCode) : ('source:' + (sourceLabel || '流入元不明'));
  }
  function ensureSourceGroup_(mediaCode, sourceLabel) {
    const key = sourceGroupKey_(mediaCode, sourceLabel);
    if (!bySource.has(key)) {
      bySource.set(key, { mediaCode: mediaCode || '', sourceLabel: mediaCode ? null : (sourceLabel || '流入元不明'), visits: 0, high: 0, mid: 0, low: 0, unknown: 0, lineOrPhoneReactions: 0 });
    }
    return bySource.get(key);
  }
  visits.forEach((v) => {
    const group = ensureSourceGroup_(v.mediaCode, v.sourceLabel);
    group.visits += 1;
    if (v.leadScore.level === '高') group.high += 1;
    else if (v.leadScore.level === '中') group.mid += 1;
    else if (v.leadScore.level === '判定不能') group.unknown += 1;
    else group.low += 1;
  });
  rows.filter((r) => r.eventType !== 'page_view').forEach((r) => {
    const group = ensureSourceGroup_(r.from || '', humanizeSource_(r.source, r.referrer).label);
    group.lineOrPhoneReactions += 1;
    if (!visitKeysSet.has(visitKey_(r.dayKey, r.visitorHashValue))) group.unknown += 1;
  });
  const sourceQuality = Array.from(bySource.values()).sort((a, b) => b.visits - a.visits || b.lineOrPhoneReactions - a.lineOrPhoneReactions);

  // (3) 離脱ポイント。施工事例／FAQを見た訪問のうち、現調・相談導線ページを見ず、
  // かつLINE/電話の反応も無かった件数を数える（人間が改善判断しやすい形の narrative）。
  let worksViewed = 0, worksNoProgress = 0, faqViewed = 0, faqNoProgress = 0;
  const exitPageCounts = new Map();
  visits.forEach((v) => {
    const hasWorks = v.pageCategories.indexOf('works') >= 0;
    const hasFaq = v.pageCategories.indexOf('faq') >= 0;
    const hasSurvey = v.pageCategories.indexOf('survey') >= 0;
    const hadAction = (v.actions || []).length > 0;
    if (hasWorks) { worksViewed += 1; if (!hasSurvey && !hadAction) worksNoProgress += 1; }
    if (hasFaq) { faqViewed += 1; if (!hasSurvey && !hadAction) faqNoProgress += 1; }
    if (!hadAction) {
      const lastPage = v.pages[v.pages.length - 1];
      const label = (lastPage && lastPage.label) || (lastPage && lastPage.path) || 'ページ不明';
      exitPageCounts.set(label, (exitPageCounts.get(label) || 0) + 1);
    }
  });
  const narratives = [];
  if (worksViewed > 0) narratives.push(`施工事例を見た訪問${worksViewed}件のうち${worksNoProgress}件が現地調査案内へ進まず離脱`);
  if (faqViewed > 0) narratives.push(`よくある質問を見た訪問${faqViewed}件のうち${faqNoProgress}件が現地調査案内へ進まず離脱`);
  const topExitPages = Array.from(exitPageCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    leadScoreBreakdown,
    sourceQuality,
    dropoff: { narratives, topExitPages }
  };
}

/**
 * 「今日」画面のコンパクトな集客通知（2026-08-31追加：集客ファネル知性化）。過去
 * windowHours時間（既定24）の実データだけを見て、営業上意味のある動き（見込み度の高い
 * 訪問／LINE・電話反応／再訪で見込み度が上がった訪問）があるかどうかを判定する。
 * トップページ1ページだけの閲覧等、低価値な単発アクセスだけでは通知しない
 * （hasNotable=falseを返し、呼び出し側はカード自体を表示しない）。
 * LINE新規友だちはfunnel_dailyが日次集計のため、正確な過去24時間ではなく「本日
 * （JST暦日）」の値を代替として使う（既存データで確実に定義できる時間窓を優先し、
 * 新しい正本テーブルは増やさない）。
 */
async function funnelRecentActivity(db, windowHours = 24, now = new Date()) {
  const endAt = now;
  const startAt = new Date(now.getTime() - windowHours * 3600 * 1000);
  const rows = await loadInteractionRows_(db, startAt, endAt);
  const visitGroups = groupVisits_(rows);
  const lookbackStartAt = new Date(startAt.getTime() - REVISIT_LOOKBACK_DAYS * 86400000);
  const lookbackRows = await loadInteractionRows_(db, lookbackStartAt, startAt);
  const priorIndex = buildPriorVisitIndex_(lookbackRows);
  const visits = buildScoredVisits_(rows, visitGroups, priorIndex);

  const newVisits = visits.length;
  const highLeadVisits = visits.filter((v) => v.leadScore.level === '高').length;
  const revisitImproved = visits.filter((v) => v.leadScore.revisit.deeperThanPrevious || v.leadScore.revisit.strongerReactionThanPrevious).length;
  const lineOrPhoneReactions = rows.filter((r) => r.eventType === 'line_click' || r.eventType === 'phone_click').length;

  // LINE新規友だちは日次集計（本日＝JSTの暦日）のみで近似する。
  let lineFollowIncrease = 0;
  try {
    const todayKey = jstDateKey(now);
    const dayDoc = await db.collection('funnel_daily').doc(todayKey).get();
    if (dayDoc.exists) lineFollowIncrease = realDailyCount_(dayDoc.data(), 'lineFollows');
  } catch (err) { lineFollowIncrease = 0; }

  const hasNotable = highLeadVisits > 0 || lineOrPhoneReactions > 0 || revisitImproved > 0 || lineFollowIncrease > 0;
  return {
    windowHours,
    newVisits,
    highLeadVisits,
    lineOrPhoneReactions,
    revisitImproved,
    lineFollowIncrease,
    hasNotable
  };
}

module.exports = {
  COUNTER_NAMES,
  PUBLIC_EVENT_COUNTERS,
  LEGACY_TEST_EXCLUSIONS,
  aggregateRows,
  authorizeBearer,
  createFunnelStore,
  dashboardPayload,
  emptyMetrics,
  funnelDrilldown,
  funnelInsights,
  funnelRecentActivity,
  isAuthorizedTestEvent,
  isDateKey,
  isLineTestEvent,
  jstDateKey,
  normalizeEvent,
  normalizeLabel,
  normalizeSalesDays,
  periodBounds,
  shiftDateKey,
  sourceKey,
  verifyLineSignature,
  visitorHash,
  visitorToken,
  // 2026-09-07追加（単位D：独立監査再提出）：見込み度の判定式そのものはV1が正本のまま
  // （このファイルは無変更・挙動は一切変わらない。追加したのはmodule.exportsへの
  // 参照だけ）。V2（funnelV2.js）が「V1の見込み度定義をvisit_id単位の新しい訪問境界へ
  // 適用する」ために、独自の簡易ルールを新設せずV1の実装をそのまま呼び出せるよう、
  // 既存の非公開関数をexportのみ追加する。groupVisits_はlegacy（visit_idを持たない
  // 旧方式ログ）の「旧ログ」区分をV1と同一の日付＋visitor_hash単位で集計するために使う。
  computeLeadScore_,
  pageCategoryOf_,
  pageKeyOf_,
  groupVisits_
};
