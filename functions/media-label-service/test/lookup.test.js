'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readMediaLabels, createHandler, READ_SCOPE } = require('../index');

test('active rows only; reads with Sheets read-only scope and returns code/label only', async () => {
  const auth = {
    async getClient() { return { getAccessToken: async () => ({ token: 'unit-token' }) }; }
  };
  const labels = await readMediaLabels({
    spreadsheetId: 'fake-sheet',
    auth,
    fetcher: async (url, options) => {
      assert.match(url, /values:batchGet/);
      assert.match(url, /B1%3AB200/);
      assert.match(url, /C1%3AC200/);
      assert.match(url, /H1%3AH200/);
      assert.equal(options.headers.Authorization, 'Bearer unit-token');
      return { ok: true, json: async () => ({ valueRanges: [
        { values: [['表示名'], ['既存名刺QR（meishi）'], ['汎用ポスティングチラシ v1'], ['次回名刺QR']] },
        { values: [['使用中'], ['はい'], ['はい'], ['いいえ']] },
        { values: [['fromコード'], ['meishi'], ['flyer_general_v1'], ['meishi_v1']] }
      ] }) };
    }
  });
  assert.deepEqual({ ...labels }, {
    meishi: '既存名刺QR（meishi）', flyer_general_v1: '汎用ポスティングチラシ v1'
  });
  assert.equal(READ_SCOPE, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.deepEqual(Object.keys(labels), ['meishi', 'flyer_general_v1']);
});

function response() {
  return {
    code: 0, headers: {}, body: '',
    writeHead(code, headers = {}) { this.code = code; this.headers = headers; return this; },
    end(body = '') { this.body = body; return this; }
  };
}

test('read-only endpoint returns only labels, errors give no internal details', async () => {
  const success = response();
  await createHandler(async () => ({ meishi: '既存名刺QR（meishi）' }))(
    { method: 'GET', url: '/media-labels' }, success
  );
  assert.equal(success.code, 200);
  assert.deepEqual(JSON.parse(success.body), { labels: { meishi: '既存名刺QR（meishi）' } });
  assert.deepEqual(Object.keys(JSON.parse(success.body)), ['labels']);
  const failure = response();
  await createHandler(async () => { throw new Error('secret details'); })(
    { method: 'GET', url: '/media-labels' }, failure
  );
  assert.equal(failure.code, 503);
  assert.doesNotMatch(failure.body, /secret details/);
  const post = response();
  await createHandler(async () => ({}))({ method: 'POST', url: '/media-labels' }, post);
  assert.equal(post.code, 405);
});