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

/* ===================================================================
 * 単位EF配線（logInteractionV2 / logInteractionVerify / getFunnelInsightsV2）
 * 2026-09-07追加：認可・検証まわりだけをここで単体テストする（実Firestore書込みを
 * 伴う経路はfunctions/test/emulator_v2_e2e_20260907.jsで別途確認済み）。
 * =================================================================== */
test('logInteractionV2: Origin未許可は403（V1のlogInteractionと同じCORS規約）', async () => {
  const result = await invoke(functions.logInteractionV2, {
    method: 'POST', headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
    body: { schemaVersion: 2, event_id: 'e'.repeat(12), visit_id: 'v'.repeat(16), occurredAt: Date.now(), eventType: 'page_view' }
  });
  assert.equal(result.statusCode, 403);
});
test('logInteractionV2: schemaVersionが2でなければ400', async () => {
  const result = await invoke(functions.logInteractionV2, {
    method: 'POST', headers: { origin: 'https://aoki-tosou.net', 'content-type': 'application/json' },
    body: { schemaVersion: 1, event_id: 'e'.repeat(12), visit_id: 'v'.repeat(16), occurredAt: Date.now(), eventType: 'page_view' }
  });
  assert.equal(result.statusCode, 400);
});
test('logInteractionV2: GETは405', async () => {
  const result = await invoke(functions.logInteractionV2, { method: 'GET', headers: { origin: 'https://aoki-tosou.net' } });
  assert.equal(result.statusCode, 405);
});
test('logInteractionV2: Content-Lengthヘッダがrequest size上限を超えると413', async () => {
  const result = await invoke(functions.logInteractionV2, {
    method: 'POST',
    headers: { origin: 'https://aoki-tosou.net', 'content-type': 'application/json', 'content-length': '999999' },
    body: { schemaVersion: 2, event_id: 'e'.repeat(12), visit_id: 'v'.repeat(16), occurredAt: Date.now(), eventType: 'page_view' }
  });
  assert.equal(result.statusCode, 413);
});

test('logInteractionV2Verify: Authorizationヘッダなしは401でjtiを含まない', async () => {
  process.env.VERIFY_JWT_SECRET = 'unit-verify-secret-not-real-0123456789abcdef';
  const result = await invoke(functions.logInteractionV2Verify, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: { schemaVersion: 2, event_id: 'e'.repeat(12), visit_id: 'v'.repeat(16), occurredAt: Date.now(), eventType: 'page_view' }
  });
  assert.equal(result.statusCode, 401);
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'jti'), false);
});
test('logInteractionV2Verify: 不正なJWT文字列は401', async () => {
  process.env.VERIFY_JWT_SECRET = 'unit-verify-secret-not-real-0123456789abcdef';
  const result = await invoke(functions.logInteractionV2Verify, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-jwt' },
    body: { schemaVersion: 2, event_id: 'e'.repeat(12), visit_id: 'v'.repeat(16), occurredAt: Date.now(), eventType: 'page_view' }
  });
  assert.equal(result.statusCode, 401);
});
test('logInteractionV2Verify: GETは405', async () => {
  const result = await invoke(functions.logInteractionV2Verify, { method: 'GET', headers: {} });
  assert.equal(result.statusCode, 405);
});
test('logInteractionV2Verify: audが異なるJWTは401（正式名logInteractionV2Verifyでなければ拒否）', async () => {
  const secret = 'unit-verify-secret-not-real-0123456789abcdef';
  process.env.VERIFY_JWT_SECRET = secret;
  const { signVerifyJwt } = require('../lib/funnelV2');
  const { token } = signVerifyJwt(secret, { sub: 'info@aoki-tosou.net', aud: 'someOtherFunction', scope: 'write:interaction_logs_v2_verify' });
  const result = await invoke(functions.logInteractionV2Verify, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: { schemaVersion: 2, event_id: 'e'.repeat(12), visit_id: 'v'.repeat(16), occurredAt: Date.now(), eventType: 'page_view' }
  });
  assert.equal(result.statusCode, 401);
});

test('getFunnelInsightsV2: トークンなしは401（既存getFunnelDashboard等と同じ認可契約）', async () => {
  process.env.FUNNEL_DASHBOARD_TOKEN = 'unit-dashboard-token';
  const result = await invoke(functions.getFunnelInsightsV2, { method: 'GET' });
  assert.equal(result.statusCode, 401);
});
test('getFunnelInsightsV2: POSTは405', async () => {
  process.env.FUNNEL_DASHBOARD_TOKEN = 'unit-dashboard-token';
  const result = await invoke(functions.getFunnelInsightsV2, {
    method: 'POST', headers: { authorization: 'Bearer unit-dashboard-token' }
  });
  assert.equal(result.statusCode, 405);
});
test('getFunnelInsightsV2Verify: JWTなしは401', async () => {
  process.env.VERIFY_JWT_SECRET = 'unit-verify-secret-not-real-0123456789abcdef';
  const result = await invoke(functions.getFunnelInsightsV2Verify, { method: 'GET' });
  assert.equal(result.statusCode, 401);
});

test('getFunnelDrilldownV2: トークンなしは401', async () => {
  process.env.FUNNEL_DASHBOARD_TOKEN = 'unit-dashboard-token';
  const result = await invoke(functions.getFunnelDrilldownV2, { method: 'GET' });
  assert.equal(result.statusCode, 401);
});
test('getFunnelDrilldownV2: POSTは405', async () => {
  process.env.FUNNEL_DASHBOARD_TOKEN = 'unit-dashboard-token';
  const result = await invoke(functions.getFunnelDrilldownV2, { method: 'POST', headers: { authorization: 'Bearer unit-dashboard-token' } });
  assert.equal(result.statusCode, 405);
});
test('getFunnelDrilldownV2Verify: JWTなしは401', async () => {
  process.env.VERIFY_JWT_SECRET = 'unit-verify-secret-not-real-0123456789abcdef';
  const result = await invoke(functions.getFunnelDrilldownV2Verify, { method: 'GET' });
  assert.equal(result.statusCode, 401);
});

test('getFunnelRecentActivityV2: トークンなしは401', async () => {
  process.env.FUNNEL_DASHBOARD_TOKEN = 'unit-dashboard-token';
  const result = await invoke(functions.getFunnelRecentActivityV2, { method: 'GET' });
  assert.equal(result.statusCode, 401);
});
test('getFunnelRecentActivityV2Verify: JWTなしは401', async () => {
  process.env.VERIFY_JWT_SECRET = 'unit-verify-secret-not-real-0123456789abcdef';
  const result = await invoke(functions.getFunnelRecentActivityV2Verify, { method: 'GET' });
  assert.equal(result.statusCode, 401);
});
