'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  LINE_PUSH_ENDPOINT, safeErrorSummary, formatMediaSource,
  formatFormAdminMessage, formatOtherAdminMessage, sendAdminLinePush
} = require('../lib/line');

const functionsRoot = path.join(__dirname, '..');
const repoRoot = path.join(functionsRoot, '..');

function productionJavaScript() {
  return [
    path.join(functionsRoot, 'index.js'),
    path.join(functionsRoot, 'lib', 'funnel.js'),
    path.join(functionsRoot, 'lib', 'line.js')
  ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

test('LINE本番コードはpush専用でbroadcast系エンドポイントを持たない', () => {
  const source = productionJavaScript();
  assert.equal(LINE_PUSH_ENDPOINT, 'https://api.line.me/v2/bot/message/push');
  assert.doesNotMatch(source, /\/v2\/bot\/message\/(?:broadcast|multicast|narrowcast|reply)(?:['"/]|$)/);
  assert.equal((source.match(/https:\/\/api\.line\.me\/v2\/bot\/message\/push/g) || []).length, 1);
});

test('両フォームの管理者通知に媒体を表示し、直接流入も分かるようにする', async () => {
  for (const source of ['meishi', 'area_check_v1', 'direct', '']) {
    const label = source && source !== 'direct' ? source : '直接・不明';
    const formText = formatFormAdminMessage({
      name: '山田', address: '大分市', phone: '0971234567',
      datetime: '午後', message: '見積希望', source
    });
    const otherText = formatOtherAdminMessage({
      name: '佐藤', city: '別府市', works: ['塗装'], date1: '2026-10-01',
      detail: '相談希望', source
    });
    assert.match(formText, new RegExp(`■ 媒体: ${label}\\n`));
    assert.match(otherText, new RegExp(`媒体: ${label}\\n`));
    assert.match(formText, /■ 名前: 山田\n■ 住所: 大分市\n■ 電話: 0971234567/);
    assert.match(otherText, /名前: 佐藤\n住所: 別府市\n依頼内容: 塗装/);
    const pushes = [];
    const result = await sendAdminLinePush({ post: async (_url, body) => { pushes.push(body); } }, {
      token: 'unit-token', to: 'unit-admin', messages: [
        { type: 'text', text: formText }, { type: 'text', text: otherText }
      ]
    });
    assert.equal(result.sent, true);
    assert.equal(pushes[0].to, 'unit-admin');
    assert.deepEqual(pushes[0].messages.map((m) => m.text), [formText, otherText]);
  }
  assert.equal(formatMediaSource('meishi\n偽装: あり'), '直接・不明');
});

test('LINE送信失敗はfail-softでSecretとPIIをログへ出さない', async () => {
  const logs = [];
  const logger = { warn() {}, error(...args) { logs.push(args); } };
  const httpClient = {
    async post() {
      const error = new Error('request failed');
      error.code = 'ETIMEDOUT';
      error.response = { status: 503 };
      error.config = { headers: { Authorization: 'Bearer production-secret-value' }, data: '顧客氏名と電話番号' };
      throw error;
    }
  };
  const result = await sendAdminLinePush(httpClient, {
    context: 'unit', token: 'production-secret-value', to: 'admin-id', messages: [{ type: 'text', text: '顧客氏名と電話番号' }]
  }, logger);
  assert.deepEqual(result, { sent: false, skipped: false });
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /production-secret-value|顧客氏名|電話番号|Authorization/);
  assert.match(serialized, /503|ETIMEDOUT/);
});

test('LINEエラー要約は安全な最小項目だけ返す', () => {
  const error = new Error('failed');
  error.response = { status: 500, data: { customer: 'PII' } };
  error.config = { headers: { Authorization: 'Bearer secret' } };
  assert.deepEqual(safeErrorSummary(error), { status: 500, code: null, message: 'failed' });
});

test('Git管理対象にenvファイルや平文Bearerトークンがない', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  assert.equal(tracked.some((file) => /(^|\/)\.env(?:\.|$)/.test(file)), false);
  assert.doesNotMatch(productionJavaScript(), /Bearer\s+[A-Za-z0-9_.-]{20,}/);
});

test('フォーム集計障害とLINE障害は問い合わせ保存成功を巻き添えにしない', () => {
  const source = fs.readFileSync(path.join(functionsRoot, 'index.js'), 'utf8');
  assert.match(source, /submitForm: funnel metric failed/);
  assert.match(source, /submitOtherInquiry: funnel metric failed/);
  assert.match(source, /await sendAdminLinePush\(axios/);
  assert.match(fs.readFileSync(path.join(functionsRoot, 'lib', 'line.js'), 'utf8'), /return \{ sent: false, skipped: false \}/);
});
