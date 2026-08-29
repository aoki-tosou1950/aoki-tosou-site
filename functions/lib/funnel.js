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
    currentPage: String(body && body.current_page || '').trim().slice(0, 500),
    landingPage: String(body && body.landing_page || '').trim().slice(0, 500),
    referrer: String(body && body.referrer || '').trim().slice(0, 500),
    contactChannel: String(body && body.contact_channel || '').trim().slice(0, 30)
  };
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
  const sources = {};
  (siteRows || []).forEach((row) => {
    COUNTER_NAMES.forEach((name) => {
      if (!['inquiries', 'surveys', 'estimates', 'orders'].includes(name)) {
        metrics[name] += integer(row && row.metrics && row.metrics[name]);
      }
    });
    Object.values(row && row.sources || {}).forEach((source) => {
      const label = normalizeLabel(source && source.label);
      if (!sources[label]) sources[label] = { source: label, visitors: 0, pageViews: 0, lineClicks: 0 };
      sources[label].visitors += integer(source.visitors);
      sources[label].pageViews += integer(source.pageViews);
      sources[label].lineClicks += integer(source.lineClicks);
    });
  });
  (salesRows || []).forEach((row) => {
    ['inquiries', 'surveys', 'estimates', 'orders'].forEach((name) => {
      metrics[name] += integer(row && row[name]);
    });
  });
  const topSources = Object.values(sources)
    .sort((a, b) => b.visitors - a.visitors || b.pageViews - a.pageViews || a.source.localeCompare(b.source, 'ja'))
    .slice(0, 8);
  return { metrics, topSources };
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
    stages,
    topSources: aggregate.topSources,
    lineInsight: lineInsight || { available: false, reason: 'LINE統計未取得' }
  };
}

function createFunnelStore(db) {
  function currentDailyData(snapshot, day) {
    const data = snapshot.exists ? snapshot.data() : {};
    return { date: day, metrics: Object.assign({}, data.metrics || {}), sources: Object.assign({}, data.sources || {}) };
  }

  async function recordWebEvent(event, now = new Date()) {
    if (!event.counter) return { recorded: false, reason: 'legacy_event' };
    const day = jstDateKey(now);
    const dayRef = db.collection('funnel_daily').doc(day);
    const eventRef = dayRef.collection('events').doc(event.eventId);
    const dailyVisitorRef = event.eventType === 'page_view'
      ? dayRef.collection('visitors').doc(visitorHash(day, event.visitorId))
      : null;
    return db.runTransaction(async (transaction) => {
      const daySnapshot = await transaction.get(dayRef);
      const eventSnapshot = await transaction.get(eventRef);
      const visitorSnapshot = dailyVisitorRef ? await transaction.get(dailyVisitorRef) : null;
      if (eventSnapshot.exists) return { recorded: false, duplicate: true };
      const daily = currentDailyData(daySnapshot, day);
      const key = sourceKey(event.source);
      const source = Object.assign({ label: event.source, visitors: 0, pageViews: 0, lineClicks: 0 }, daily.sources[key] || {});
      daily.metrics[event.counter] = Number(daily.metrics[event.counter] || 0) + 1;
      if (event.eventType === 'page_view') source.pageViews += 1;
      if (event.eventType === 'line_click') source.lineClicks += 1;
      if (dailyVisitorRef && !visitorSnapshot.exists) {
        daily.metrics.visitors = Number(daily.metrics.visitors || 0) + 1;
        source.visitors += 1;
        transaction.create(dailyVisitorRef, { createdAt: now });
      }
      daily.sources[key] = source;
      transaction.set(dayRef, Object.assign(daily, { updatedAt: now }), { merge: true });
      transaction.create(eventRef, { eventType: event.eventType, createdAt: now });
      return { recorded: true, visitorAdded: Boolean(dailyVisitorRef && !visitorSnapshot.exists) };
    });
  }

  async function recordInternalMetric(counter, eventId, source, now = new Date()) {
    const day = jstDateKey(now);
    const dayRef = db.collection('funnel_daily').doc(day);
    const eventRef = dayRef.collection('events').doc(eventId);
    return db.runTransaction(async (transaction) => {
      const daySnapshot = await transaction.get(dayRef);
      const eventSnapshot = await transaction.get(eventRef);
      if (eventSnapshot.exists) return false;
      const daily = currentDailyData(daySnapshot, day);
      daily.metrics[counter] = Number(daily.metrics[counter] || 0) + 1;
      transaction.set(dayRef, Object.assign(daily, { updatedAt: now }), { merge: true });
      transaction.create(eventRef, { eventType: counter, source: normalizeLabel(source), createdAt: now });
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
    return db.runTransaction(async (transaction) => {
      const daySnapshot = await transaction.get(dayRef);
      const eventSnapshot = await transaction.get(eventRef);
      if (eventSnapshot.exists) return false;
      const daily = currentDailyData(daySnapshot, day);
      daily.metrics[counter] = Number(daily.metrics[counter] || 0) + 1;
      transaction.set(dayRef, Object.assign(daily, { updatedAt: new Date() }), { merge: true });
      transaction.create(eventRef, { type: event.type, occurredAt: now, createdAt: new Date() });
      return true;
    });
  }

  return { recordInternalMetric, recordLineEvent, recordWebEvent };
}

module.exports = {
  COUNTER_NAMES,
  PUBLIC_EVENT_COUNTERS,
  aggregateRows,
  authorizeBearer,
  createFunnelStore,
  dashboardPayload,
  emptyMetrics,
  isDateKey,
  jstDateKey,
  normalizeEvent,
  normalizeLabel,
  normalizeSalesDays,
  periodBounds,
  shiftDateKey,
  sourceKey,
  verifyLineSignature,
  visitorHash
};
