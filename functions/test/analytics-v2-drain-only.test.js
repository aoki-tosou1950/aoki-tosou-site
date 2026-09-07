'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const script = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'analytics-v2-drain-only.js'), 'utf8');
const RealDate = Date;

/**
 * js/analytics-v2-drain-only.jsをNode vmコンテキストで実行するテストハーネス
 * （独立監査再提出R9・項目7）。analytics-v2.test.jsのbrowser()ハーネスと同じ
 * 設計方針（fetchResponderによる呼び出しごとの応答制御・fake Date）を踏襲するが、
 * drain-onlyローダー自身はsetTimeout/sendBeacon/クリックbindingを一切使わない
 * ため、それらのfakeは持たない（無い依存を偽装しても意味が無い）。
 */
function browser(opts) {
  opts = opts || {};
  const localStore = opts.localStore || new Map();
  const fetchCalls = [];
  let currentNow = opts.now || RealDate.parse('2026-09-07T00:00:00+09:00');

  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(currentNow);
    return new RealDate(...args);
  }
  FakeDate.now = () => currentNow;
  FakeDate.prototype = RealDate.prototype;

  const fetchResponder = opts.fetchResponder || (() => ({ status: 200 }));
  const fetchAvailable = opts.fetchAvailable !== false;

  const windowObj = {
    localStorage: {
      getItem(key) { return localStore.has(key) ? localStore.get(key) : null; },
      setItem(key, value) { localStore.set(key, String(value)); },
      removeItem(key) { localStore.delete(key); }
    }
  };
  if (fetchAvailable) {
    windowObj.fetch = function (endpoint, init) {
      const callIndex = fetchCalls.length;
      const body = JSON.parse(init.body);
      fetchCalls.push({ endpoint, body, init });
      let result;
      try {
        result = fetchResponder(endpoint, init, callIndex, body);
      } catch (err) {
        return Promise.reject(err);
      }
      const status = (result && typeof result.status === 'number') ? result.status : 200;
      return Promise.resolve({ ok: status >= 200 && status < 300, status });
    };
  }

  const context = { URL, URLSearchParams, Date: FakeDate, Math, JSON, Promise, console, window: windowObj };
  vm.runInNewContext(script, context);

  return {
    fetchCalls, localStore,
    api: context.window.aokiAnalyticsV2DrainOnly,
    advance(ms) { currentNow += ms; }
  };
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

function seedOutbox(localStore, items) {
  localStore.set('aoki_analytics_v2_outbox', JSON.stringify(items));
}

function makeItem(overrides) {
  return Object.assign({
    generation: 2,
    event: { event_id: 'evt-' + Math.random().toString(16).slice(2), schemaVersion: 2, event_type: 'page_view' },
    addedAt: RealDate.parse('2026-09-07T00:00:00+09:00'),
    attempts: 0,
    nextRetryAt: 0
  }, overrides);
}

test('R9#7：drain-onlyローダーは新規イベントを一切生成しない（track相当のAPIを公開しない）', () => {
  const b = browser({ localStore: new Map() });
  assert.equal(typeof b.api.track, 'undefined');
  assert.equal(typeof b.api.bindClicks, 'undefined');
});

test('R9#7：既存outboxが空なら、ロード時に何も送信しない', async () => {
  const localStore = new Map();
  const b = browser({ localStore });
  await tick();
  assert.equal(b.fetchCalls.length, 0);
});

test('R9#7：既存outboxにnextRetryAt<=nowの1件があれば、ロード時にV2 writerエンドポイントへ排出する', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0 });
  seedOutbox(localStore, [item]);
  const b = browser({ localStore, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assert.equal(b.fetchCalls.length, 1);
  assert.match(b.fetchCalls[0].endpoint, /logInteractionV2$/);
  assert.equal(b.fetchCalls[0].endpoint.indexOf('logInteractionV2Verify'), -1);
  assert.equal(b.fetchCalls[0].body.event_id, item.event.event_id);
});

test('R9#7：V1 writer（logInteraction）へは絶対に送らない（エンドポイント定数自体がV2 writer固定）', () => {
  const localStore = new Map();
  const b = browser({ localStore });
  assert.match(b.api._internal.ENDPOINT, /logInteractionV2$/);
  assert.doesNotMatch(b.api._internal.ENDPOINT, /\/logInteraction$/);
});

test('R9#7：24時間を超えたエントリは排出せず破棄する（それ以降二度と送信されない）', async () => {
  const localStore = new Map();
  const old = makeItem({ addedAt: RealDate.parse('2026-09-07T00:00:00+09:00'), nextRetryAt: 0 });
  const startNow = RealDate.parse('2026-09-08T00:00:01+09:00'); // 24時間+1秒後
  seedOutbox(localStore, [old]);
  const b = browser({ localStore, now: startNow, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assert.equal(b.fetchCalls.length, 0);
  const remaining = JSON.parse(localStore.get('aoki_analytics_v2_outbox'));
  assert.equal(remaining.length, 0);
});

test('R9#7：24時間以内（ぎりぎり）のエントリは排出対象になる（境界値）', async () => {
  const localStore = new Map();
  const fresh = makeItem({ addedAt: RealDate.parse('2026-09-07T00:00:00+09:00'), nextRetryAt: 0 });
  const startNow = RealDate.parse('2026-09-07T23:59:59+09:00'); // 24時間-1秒後
  seedOutbox(localStore, [fresh]);
  const b = browser({ localStore, now: startNow, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assert.equal(b.fetchCalls.length, 1);
});

test('R9#7：nextRetryAt猶予中のエントリはロード時に送信しない（猶予を無視して強制排出しない）', async () => {
  const localStore = new Map();
  const waiting = makeItem({ nextRetryAt: RealDate.parse('2026-09-07T00:00:00+09:00') + 60 * 60 * 1000 });
  seedOutbox(localStore, [waiting]);
  const b = browser({ localStore, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assert.equal(b.fetchCalls.length, 0);
});

test('R9#7：送信成功（200）でoutboxから当該エントリが削除される', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0 });
  seedOutbox(localStore, [item]);
  const b = browser({ localStore, fetchResponder: () => ({ status: 200 }) });
  await tick();
  await tick();
  const remaining = JSON.parse(localStore.get('aoki_analytics_v2_outbox'));
  assert.equal(remaining.length, 0);
});

test('R9#7：401応答は保持（retry扱い）される。drain-onlyローダーは恒久停止状態を持たない', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0, attempts: 0 });
  seedOutbox(localStore, [item]);
  const b = browser({ localStore, fetchResponder: () => ({ status: 401 }) });
  await tick();
  await tick();
  const remaining = JSON.parse(localStore.get('aoki_analytics_v2_outbox'));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].attempts, 1);
  assert.ok(remaining[0].nextRetryAt > 0);
});

test('R9#7：400等の恒久失敗ステータスは、以後二度と再送されないようにoutboxから削除する', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0 });
  seedOutbox(localStore, [item]);
  const b = browser({ localStore, fetchResponder: () => ({ status: 400 }) });
  await tick();
  await tick();
  const remaining = JSON.parse(localStore.get('aoki_analytics_v2_outbox'));
  assert.equal(remaining.length, 0);
});

test('R9#7：window.fetchが存在しない環境では例外を投げず何もしない（fail-soft）', () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0 });
  seedOutbox(localStore, [item]);
  assert.doesNotThrow(() => browser({ localStore, fetchAvailable: false }));
});

test('R9#7：世代（generation）不一致のエントリは対象外として無視・破棄する（別バージョンのoutbox形状を誤って送信しない）', async () => {
  const localStore = new Map();
  const wrongGen = makeItem({ generation: 99, nextRetryAt: 0 });
  seedOutbox(localStore, [wrongGen]);
  const b = browser({ localStore, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assert.equal(b.fetchCalls.length, 0);
});
