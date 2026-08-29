'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const project = process.env.GCLOUD_PROJECT || 'demo-aokitosou';
const base = `http://127.0.0.1:5001/${project}/us-central1`;
const db = getFirestore(initializeApp({ projectId: project }, 'integration-test'));

async function request(name, options) {
  return fetch(`${base}/${name}`, options);
}

test('Functions Emulator 集客ファネル一気通貫', async (t) => {
  const event = { event_type: 'page_view', event_id: 'e_integration0001', visitor_id: 'v_integration_visitor_0001', source: 'test' };
  const options = { method: 'POST', headers: { Origin: 'https://aoki-tosou.net', 'Content-Type': 'application/json' }, body: JSON.stringify(event) };
  await t.test('訪問とPVを記録', async () => {
    const response = await request('logInteraction', options);
    assert.equal(response.status, 200);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const data = (await db.collection('funnel_daily').doc(day).get()).data();
    assert.equal(data.metrics.visitors, 1);
    assert.equal(data.metrics.pageViews, 1);
  });
  await t.test('同一event_idは重複計上しない', async () => {
    assert.equal((await request('logInteraction', options)).status, 200);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const data = (await db.collection('funnel_daily').doc(day).get()).data();
    assert.equal(data.metrics.pageViews, 1);
  });
  await t.test('同一匿名訪問者の別PVはPVだけ加算', async () => {
    const next = Object.assign({}, event, { event_id: 'e_integration0002' });
    assert.equal((await request('logInteraction', Object.assign({}, options, { body: JSON.stringify(next) }))).status, 200);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const data = (await db.collection('funnel_daily').doc(day).get()).data();
    assert.equal(data.metrics.visitors, 1);
    assert.equal(data.metrics.pageViews, 2);
  });
  await t.test('LINE follow署名正常・重複耐性', async () => {
    const body = Buffer.from(JSON.stringify({ events: [{ type: 'follow', webhookEventId: '01LINEINTEGRATION0000000001', timestamp: Date.now() }] }));
    const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
    const call = () => request('lineWebhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': signature }, body });
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const data = (await db.collection('funnel_daily').doc(day).get()).data();
    assert.equal(data.metrics.lineFollows, 1);
  });
  await t.test('LINE不正署名を拒否', async () => {
    const response = await request('lineWebhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': 'invalid' }, body: '{"events":[]}' });
    assert.equal(response.status, 401);
  });
  await t.test('LINE unfollowを記録', async () => {
    const body = Buffer.from(JSON.stringify({ events: [{ type: 'unfollow', webhookEventId: '01LINEINTEGRATION0000000002', timestamp: Date.now() }] }));
    const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
    assert.equal((await request('lineWebhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': signature }, body })).status, 200);
  });
  await t.test('営業OS adapterを冪等同期', async () => {
    const body = JSON.stringify({ source: 'test', days: [{ date: '2026-08-29', inquiries: 6, surveys: 5, estimates: 4, orders: 2 }] });
    const call = () => request('syncSalesFunnel', { method: 'POST', headers: { Authorization: 'Bearer integration-token', 'Content-Type': 'application/json' }, body });
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    assert.equal((await db.collection('funnel_sales_daily').doc('2026-08-29').get()).data().orders, 2);
  });
  await t.test('既存フォーム回帰と送信集計', async () => {
    const response = await request('submitForm', { method: 'POST', headers: { Origin: 'https://aoki-tosou.net', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'テスト', address: '大分市', phone: '097-000-0000', source: 'integration' }) });
    assert.equal(response.status, 200);
    assert.equal((await db.collection('submissions').get()).size, 1);
  });
});
