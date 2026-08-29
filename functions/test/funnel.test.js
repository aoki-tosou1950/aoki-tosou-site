'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  aggregateRows,
  authorizeBearer,
  createFunnelStore,
  dashboardPayload,
  emptyMetrics,
  isDateKey,
  jstDateKey,
  normalizeEvent,
  normalizeSalesDays,
  periodBounds,
  sourceKey,
  verifyLineSignature,
  visitorHash
} = require('../lib/funnel');

function fakeFirestore() {
  const data = new Map();
  function ref(path) {
    return { path, collection(name) { return { doc(id) { return ref(`${path}/${name}/${id}`); } }; } };
  }
  const transaction = {
    async get(document) { return { exists: data.has(document.path), data() { return data.get(document.path); } }; },
    set(document, value, options) { data.set(document.path, options && options.merge ? Object.assign({}, data.get(document.path) || {}, value) : value); },
    create(document, value) { if (data.has(document.path)) throw new Error('already exists'); data.set(document.path, value); }
  };
  return {
    _data: data,
    collection(name) { return { doc(id) { return ref(`${name}/${id}`); } }; },
    async runTransaction(callback) { return callback(transaction); }
  };
}

test('JST日付をUTC境界から正しく求める', () => {
  assert.equal(jstDateKey(new Date('2026-08-28T15:30:00Z')), '2026-08-29');
});

test('今月の期間をJSTで求める', () => {
  assert.deepEqual(periodBounds('thisMonth', new Date('2026-08-29T03:00:00Z')), { start: '2026-08-01', end: '2026-08-29' });
});

test('先月の月末を正しく求める', () => {
  assert.deepEqual(periodBounds('lastMonth', new Date('2026-03-04T03:00:00Z')), { start: '2026-02-01', end: '2026-02-28' });
});

test('今週は月曜開始', () => {
  assert.deepEqual(periodBounds('thisWeek', new Date('2026-08-29T03:00:00Z')), { start: '2026-08-24', end: '2026-08-29' });
});

test('日付キーの実在日を検証する', () => {
  assert.equal(isDateKey('2024-02-29'), true);
  assert.equal(isDateKey('2026-02-29'), false);
});

test('訪問イベントを正規化する', () => {
  const event = normalizeEvent({ event_type: 'page_view', event_id: 'e_123456789012', visitor_id: 'v_1234567890123456', source: ' flyer ' });
  assert.equal(event.counter, 'pageViews');
  assert.equal(event.source, 'flyer');
});

test('未知のイベントを拒否する', () => {
  assert.throws(() => normalizeEvent({ event_type: 'purchase', event_id: 'e_123456789012' }), /Unsupported/);
});

test('訪問イベントはvisitor_id必須', () => {
  assert.throws(() => normalizeEvent({ event_type: 'page_view', event_id: 'e_123456789012' }), /visitor_id/);
});

test('LINE署名の正常系', () => {
  const body = Buffer.from('{"events":[]}');
  const secret = 'test-secret';
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyLineSignature(body, signature, secret), true);
});

test('LINE署名の改ざんを拒否する', () => {
  const body = Buffer.from('{"events":[]}');
  assert.equal(verifyLineSignature(body, 'bad-signature', 'test-secret'), false);
});

test('Bearerトークンの正常系と異常系', () => {
  assert.equal(authorizeBearer('Bearer same-token', 'same-token'), true);
  assert.equal(authorizeBearer('Bearer wrong', 'same-token'), false);
  assert.equal(authorizeBearer('', 'same-token'), false);
});

test('営業OS欠損値は0として受ける', () => {
  assert.deepEqual(normalizeSalesDays([{ date: '2026-08-29', inquiries: 2 }]), [{ date: '2026-08-29', inquiries: 2, surveys: 0, estimates: 0, orders: 0 }]);
});

test('営業OSの重複日を拒否する', () => {
  assert.throws(() => normalizeSalesDays([{ date: '2026-08-29' }, { date: '2026-08-29' }]), /duplicate/);
});

test('営業OSの負数を0へ正規化する', () => {
  assert.equal(normalizeSalesDays([{ date: '2026-08-29', orders: -1 }])[0].orders, 0);
});

test('0件日を0のまま集計する', () => {
  assert.deepEqual(aggregateRows([], []).metrics, emptyMetrics());
});

test('サイトと営業OSを期間合算する', () => {
  const result = aggregateRows([
    { metrics: { visitors: 3, pageViews: 5, lineClicks: 2, phoneClicks: 1, inquirySubmits: 1, lineFollows: 1, lineUnfollows: 0 }, sources: { abc: { label: 'flyer', visitors: 3, pageViews: 5, lineClicks: 2 } } }
  ], [{ inquiries: 2, surveys: 1, estimates: 1, orders: 1 }]);
  assert.equal(result.metrics.visitors, 3);
  assert.equal(result.metrics.orders, 1);
  assert.equal(result.topSources[0].source, 'flyer');
});

test('転換率は分母0なら推測せずnull', () => {
  const payload = dashboardPayload({ start: '2026-08-01', end: '2026-08-29' }, [], [], null);
  assert.equal(payload.stages[1].conversionRate, null);
});

test('流入元キーは同じラベルで安定する', () => {
  assert.equal(sourceKey('Google'), sourceKey('Google'));
  assert.notEqual(sourceKey('Google'), sourceKey('LINE'));
});

test('匿名訪問者ハッシュは日別で変わる', () => {
  assert.notEqual(visitorHash('2026-08-28', 'v_1234567890123456'), visitorHash('2026-08-29', 'v_1234567890123456'));
});

test('訪問集計は同一event_idを重複計上しない', async () => {
  const db = fakeFirestore(), store = createFunnelStore(db), now = new Date('2026-08-29T03:00:00Z');
  const event = normalizeEvent({ event_type: 'page_view', event_id: 'e_store_123456789', visitor_id: 'v_store_123456789012', source: 'test' });
  assert.equal((await store.recordWebEvent(event, now)).recorded, true);
  assert.equal((await store.recordWebEvent(event, now)).duplicate, true);
  const metrics = db._data.get('funnel_daily/2026-08-29').metrics;
  assert.equal(metrics.visitors, 1);
  assert.equal(metrics.pageViews, 1);
});

test('同じ匿名訪問者の別PVはvisitorを増やさない', async () => {
  const db = fakeFirestore(), store = createFunnelStore(db), now = new Date('2026-08-29T03:00:00Z');
  const base = { event_type: 'page_view', visitor_id: 'v_store_123456789012', source: 'test' };
  await store.recordWebEvent(normalizeEvent(Object.assign({ event_id: 'e_store_123456789' }, base)), now);
  await store.recordWebEvent(normalizeEvent(Object.assign({ event_id: 'e_store_987654321' }, base)), now);
  const metrics = db._data.get('funnel_daily/2026-08-29').metrics;
  assert.equal(metrics.visitors, 1);
  assert.equal(metrics.pageViews, 2);
});

test('LINE webhookEventIdでfollowを冪等化する', async () => {
  const db = fakeFirestore(), store = createFunnelStore(db);
  const event = { type: 'follow', webhookEventId: '01STORELINEEVENT0000000001', timestamp: Date.parse('2026-08-29T03:00:00Z') };
  assert.equal(await store.recordLineEvent(event), true);
  assert.equal(await store.recordLineEvent(event), false);
  assert.equal(db._data.get('funnel_daily/2026-08-29').metrics.lineFollows, 1);
});

test('フォーム送信集計はsubmission IDで冪等化する', async () => {
  const db = fakeFirestore(), store = createFunnelStore(db), now = new Date('2026-08-29T03:00:00Z');
  assert.equal(await store.recordInternalMetric('inquirySubmits', 'form_submission_001', 'form', now), true);
  assert.equal(await store.recordInternalMetric('inquirySubmits', 'form_submission_001', 'form', now), false);
  assert.equal(db._data.get('funnel_daily/2026-08-29').metrics.inquirySubmits, 1);
});
