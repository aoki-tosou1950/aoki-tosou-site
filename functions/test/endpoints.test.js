'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const functions = require('../index');

function response() {
  let resolve;
  const done = new Promise((ready) => { resolve = ready; });
  const state = { statusCode: 200, headers: {}, body: undefined };
  const res = new EventEmitter();
  res.set = (name, value) => { state.headers[name] = value; return res; };
  res.status = (code) => { state.statusCode = code; return res; };
  res.json = (body) => { state.body = body; resolve(state); res.emit('finish'); return res; };
  res.send = (body) => { state.body = body; resolve(state); res.emit('finish'); return res; };
  return { res, done };
}

async function invoke(fn, req) {
  const target = response();
  await fn(Object.assign({ headers: {}, query: {} }, req), target.res);
  return target.done;
}

test('LINE webhook handlerは不正署名を401で拒否する', async () => {
  process.env.LINE_CHANNEL_SECRET = 'unit-channel-secret';
  const result = await invoke(functions.lineWebhook, {
    method: 'POST', rawBody: Buffer.from('{"events":[]}'), headers: { 'x-line-signature': 'invalid' }
  });
  assert.equal(result.statusCode, 401);
});

test('LINE webhook handlerは署名済み検証リクエストを受理する', async () => {
  process.env.LINE_CHANNEL_SECRET = 'unit-channel-secret';
  const rawBody = Buffer.from('{"events":[]}');
  const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
  const result = await invoke(functions.lineWebhook, {
    method: 'POST', rawBody, headers: { 'x-line-signature': signature }
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, recorded: 0 });
});

test('集計APIはトークンなしを拒否する', async () => {
  process.env.FUNNEL_DASHBOARD_TOKEN = 'unit-dashboard-token';
  const result = await invoke(functions.getFunnelDashboard, { method: 'GET' });
  assert.equal(result.statusCode, 401);
});

test('営業OS同期APIはトークンなしを拒否する', async () => {
  process.env.FUNNEL_DASHBOARD_TOKEN = 'unit-dashboard-token';
  const result = await invoke(functions.syncSalesFunnel, { method: 'POST' });
  assert.equal(result.statusCode, 401);
});

test('ダッシュボードHTMLはnoindexで配信する', async () => {
  const result = await invoke(functions.funnelDashboard, { method: 'GET' });
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(result.body, /青木塗装 集客ファネル/);
});

test('既存フォームは必須項目不足を従来どおり拒否する', async () => {
  const result = await invoke(functions.submitForm, {
    method: 'POST', headers: { origin: 'https://aoki-tosou.net', 'content-type': 'application/json' }, body: {}
  });
  assert.equal(result.statusCode, 400);
  assert.match(result.body.error, /name, address, phone/);
});
