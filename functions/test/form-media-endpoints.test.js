'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const saved = [];
const pushed = [];
const metrics = [];
const db = { collection(name) { return { async add(data) {
  saved.push({ collection: name, data });
  return { id: `unit-${saved.length}` };
} }; } };

// 読み込み時からFirestoreとLINE APIを置換し、実データと実通知には触れない。
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
  if (request === 'firebase-admin/app') return { initializeApp() {} };
  if (request === 'firebase-admin/firestore') return {
    getFirestore: () => db, FieldValue: { serverTimestamp: () => 'unit-time' }
  };
  if (request === 'axios') return { post: async (url, body) => { pushed.push({ url, body }); } };
  if (request === './lib/media-labels' && parent && path.dirname(parent.filename) === path.resolve(__dirname, '..')) {
    return { mediaDisplay: async (source) => {
      if (source === 'lookup_offline') throw new Error('lookup unavailable');
      if (source === 'direct') return '直接・不明';
      return ({ meishi: '既存名刺QR（meishi）',
        area_check_v1: 'エリア点検チラシ 劣化住宅地・他社周辺 v1' })[source] ||
        '未登録の媒体（' + source + '）';
    } };
  }
  if (request === './lib/funnel' && parent && path.dirname(parent.filename) === path.resolve(__dirname, '..')) {
    const funnel = originalLoad.apply(this, arguments);
    return { ...funnel, createFunnelStore: () => ({
      recordInternalMetric: async (...args) => { metrics.push(args); },
      recordLineEvent: async () => {}, recordWebEvent: async () => {}
    }) };
  }
  return originalLoad.apply(this, arguments);
};
let functions;
try { functions = require('../index'); }
finally { Module._load = originalLoad; }
process.env.LINE_ACCESS_TOKEN = 'unit-token';
process.env.ADMIN_LINE_USER_ID = 'unit-admin';

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}

test('両フォームで保存と集計を維持し、媒体つきの管理者LINE通知を生成する', async () => {
  const cases = [
    ['submitForm', 'submissions', { name: '山田', address: '大分市中央1-2', phone: '0971234567' }],
    ['submitOtherInquiry', 'other_inquiries', { name: '佐藤', city: '別府市北浜1-2', works: ['塗装'] }]
  ];
  for (const [name, collection, base] of cases) {
    for (const source of ['meishi', 'area_check_v1', 'not_known', 'direct', 'lookup_offline']) {
      const res = response();
      await functions[name]({ method: 'POST', headers: {
        origin: 'https://aoki-tosou.net', 'content-type': 'application/json'
      }, body: { ...base, source } }, res);
      assert.equal(res.statusCode, 200, name);
      assert.equal(saved.at(-1).collection, collection);
      assert.equal(saved.at(-1).data.source, source);
      assert.equal(saved.at(-1).data.test_event, false);
      assert.equal(pushed.at(-1).url, 'https://api.line.me/v2/bot/message/push');
      assert.equal(pushed.at(-1).body.to, 'unit-admin');
      const displayed = ({ meishi: '既存名刺QR（meishi）',
        area_check_v1: 'エリア点検チラシ 劣化住宅地・他社周辺 v1',
        not_known: '未登録の媒体（not_known）', direct: '直接・不明' })[source] || source;
      assert.ok(pushed.at(-1).body.messages[0].text.includes('媒体: ' + displayed));
    }
  }
  assert.equal(saved.length, 10);
  assert.equal(pushed.length, 10);
  assert.equal(metrics.length, 10);
  assert.ok(metrics.every((args) => args[0] === 'inquirySubmits' && args[4] === false));
});
