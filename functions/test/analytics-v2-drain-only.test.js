'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// R9再監査対応・項目2：drain-onlyローダーもjs/analytics-v2-outbox-engine.jsへ委譲する
// ため、テストのvmコンテキストにも同じ順序（エンジン→drain-only本体）でロードする
// （実HTMLでのscriptタグ順序と同じ制約）。
const engineScript = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'analytics-v2-outbox-engine.js'), 'utf8');
const drainOnlyScript = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'analytics-v2-drain-only.js'), 'utf8');
const script = engineScript + '\n' + drainOnlyScript;
const RealDate = Date;

/**
 * js/analytics-v2-drain-only.jsをNode vmコンテキストで実行するテストハーネス
 * （独立監査再提出R9・項目7、R9再監査対応・項目2で更新）。
 * R9再監査対応・項目2以降、drain-onlyはjs/analytics-v2-outbox-engine.jsの
 * setTimeout駆動の試験再送タイマーへ委譲するため、analytics-v2.test.jsの
 * browser()ハーネスと同じfake setTimeout/clearTimeout機構を持つ。
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

  let fakeTimerIdSeq = 1;
  const pendingTimers = new Map();
  function fakeSetTimeout(fn, delay) {
    const id = fakeTimerIdSeq++;
    pendingTimers.set(id, { fireAt: currentNow + (Number(delay) || 0), fn });
    return id;
  }
  function fakeClearTimeout(id) { pendingTimers.delete(id); }
  function drainDueTimers() {
    let firedAny = true;
    while (firedAny) {
      firedAny = false;
      for (const [id, t] of Array.from(pendingTimers.entries())) {
        if (t.fireAt <= currentNow) {
          pendingTimers.delete(id);
          firedAny = true;
          t.fn();
        }
      }
    }
  }

  const windowObj = {
    localStorage: {
      getItem(key) { return localStore.has(key) ? localStore.get(key) : null; },
      setItem(key, value) { localStore.set(key, String(value)); },
      removeItem(key) { localStore.delete(key); }
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout
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
    advance(ms) { currentNow += ms; drainDueTimers(); },
    pendingTimerCount() { return pendingTimers.size; }
  };
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

function seedOutbox(localStore, items) {
  localStore.set('aoki_analytics_v2_outbox', JSON.stringify(items));
}
function seedStopState(localStore, state) {
  localStore.set('aoki_analytics_v2_stop_state', JSON.stringify(state));
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

test('R9再監査#2：drain-onlyのソースコード（コメントを除く実行コード部分）がengine.enqueue呼び出し・sendBeaconを一切含まない（新規イベント生成経路が構造的に存在しないことの静的確認）', () => {
  const fs2 = require('fs');
  const raw = fs2.readFileSync(path.join(__dirname, '..', '..', 'js', 'analytics-v2-drain-only.js'), 'utf8');
  // ブロックコメント（/** ... */）・行コメント（// ...）は説明文であり、実行コードではない
  // （実際「engine.enqueue()を一切呼ばない」という説明文自体がenqueue(という文字列を含む
  // ため、コメントを含めたまま素朴に文字列検索すると誤検知する）。実行コード部分だけを
  // 対象に、実際の呼び出し（.enqueue( ・ sendBeacon(）が無いことを確認する。
  const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(withoutComments, /\.enqueue\s*\(/);
  assert.doesNotMatch(withoutComments, /sendBeacon\s*\(/i);
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

test('R9#7：V1 writer（logInteraction）へは絶対に送らない（エンドポイント定数自体がV2 writer固定・エンジン共有）', () => {
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

test('R9再監査#2：24時間超過エントリの破棄は、フルトラッカーと同じ診断キー（expiredDiscardCount）へ記録される', async () => {
  const localStore = new Map();
  const old = makeItem({ addedAt: RealDate.parse('2026-09-07T00:00:00+09:00'), nextRetryAt: 0 });
  const startNow = RealDate.parse('2026-09-08T00:00:01+09:00');
  seedOutbox(localStore, [old]);
  browser({ localStore, now: startNow, fetchResponder: () => ({ status: 200 }) });
  await tick();
  const diag = JSON.parse(localStore.get('aoki_analytics_v2_outbox_diag'));
  assert.equal(diag.expiredDiscardCount, 1);
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

test('R9再監査#2：401はフルトラッカーと全く同じ全体停止（サーキットブレーカー）を引き起こす（drain-only独自のper-item retryではない）', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0, attempts: 0 });
  seedOutbox(localStore, [item]);
  const b = browser({ localStore, fetchResponder: () => ({ status: 401 }) });
  await tick();
  await tick();
  // フルトラッカーのsendViaFetch 'stop'分岐と同一：401直後はattempts/nextRetryAtを
  // 更新しない（per-item retryスケジュールではなく、全体停止状態を作る）。
  const remaining = JSON.parse(localStore.get('aoki_analytics_v2_outbox'));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].attempts, 0);
  // engineの共有停止状態（aoki_analytics_v2_stop_state）が作られている。
  assert.equal(b.api._internal.isStopped(), true);
  const stopState = JSON.parse(localStore.get('aoki_analytics_v2_stop_state'));
  assert.equal(stopState.finalStopped, false);
  assert.ok(stopState.nextTrialAt > 0);
});

test('R9再監査#2：401停止後、フルトラッカーと同じ単発timerが予約される（scheduleTrialTimer_経由）', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0 });
  seedOutbox(localStore, [item]);
  const b = browser({ localStore, fetchResponder: () => ({ status: 401 }) });
  await tick();
  await tick();
  assert.ok(b.pendingTimerCount() >= 1);
});

test('R9再監査#2：400等の恒久失敗ステータスは、以後二度と再送されないようにoutboxから削除する', async () => {
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

/* ===================================================================
 * R9再監査対応・項目2：既存停止状態を引き継いだrollbackケース
 * （V2稼働中に401サーキットブレーカーが作動済みの状態で、V1へrollbackして
 * drain-onlyローダーがロードされた場合）
 * =================================================================== */

test('R9再監査#2：既にフルトラッカーが停止中（finalStopped=false）の状態でロードされた場合、drain-onlyは即座にoutboxをflushせず、停止状態を尊重してtimerだけを予約する', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0 });
  seedOutbox(localStore, [item]);
  const now = RealDate.parse('2026-09-07T00:00:00+09:00');
  // フルトラッカー側で既に401が1回発生し、次回試験まで15分待機中、という状態を再現する。
  seedStopState(localStore, { stoppedAt: now, trialCount: 0, totalAttempts: 1, nextTrialAt: now + 15 * 60 * 1000, finalStopped: false });
  const b = browser({ localStore, now, fetchResponder: () => ({ status: 200 }) });
  await tick();
  // 停止中は即座にflushしない（迂回しない）。
  assert.equal(b.fetchCalls.length, 0);
  assert.equal(b.api._internal.isStopped(), true);
  // ただしフルトラッカーと同じくtimerは予約されている（期限が来れば自動的に試験する）。
  assert.ok(b.pendingTimerCount() >= 1);
});

test('R9再監査#2：既存の停止状態のnextTrialAtが来た時点で、fake timerの経過だけでoutbox最古の1件だけが試験再送される（drain-only独自のロジックではなくengine.attemptTrialResend経由）', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0 });
  seedOutbox(localStore, [item]);
  const now = RealDate.parse('2026-09-07T00:00:00+09:00');
  seedStopState(localStore, { stoppedAt: now, trialCount: 0, totalAttempts: 1, nextTrialAt: now + 15 * 60 * 1000, finalStopped: false });
  const b = browser({ localStore, now, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assert.equal(b.fetchCalls.length, 0);
  b.advance(15 * 60 * 1000 + 1000);
  await tick();
  assert.equal(b.fetchCalls.length, 1);
  assert.equal(b.fetchCalls[0].body.event_id, item.event.event_id);
  // 試験再送が成功したのでclearStopされ、停止状態が解除されている。
  assert.equal(b.api._internal.isStopped(), false);
});

test('R9再監査#2：既にfinalStopped=trueの状態でロードされた場合、drain-onlyは一切自動試験しない（timerを予約しない・fetchを一切呼ばない）', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0 });
  seedOutbox(localStore, [item]);
  const now = RealDate.parse('2026-09-07T00:00:00+09:00');
  seedStopState(localStore, { stoppedAt: now, trialCount: 4, totalAttempts: 4, nextTrialAt: null, finalStopped: true });
  const b = browser({ localStore, now, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assert.equal(b.fetchCalls.length, 0);
  assert.equal(b.api._internal.isFinalStopped(), true);
  assert.equal(b.pendingTimerCount(), 0);
  // 時間を大きく進めても、finalStopped後は一切試行しない。
  b.advance(10 * 60 * 60 * 1000);
  await tick();
  assert.equal(b.fetchCalls.length, 0);
});

test('R9再監査#2：drain-only経由の試験再送で401が4回連続すると、フルトラッカーと同じくfinalStopped=trueになり以後は自動試験しない（回数上限を共有・drain-onlyが独自の上限を持たない）', async () => {
  const localStore = new Map();
  const item = makeItem({ nextRetryAt: 0 });
  seedOutbox(localStore, [item]);
  const b = browser({ localStore, fetchResponder: () => ({ status: 401 }) });
  await tick(); // 1回目401（通常送信経由）→ beginStop
  await tick();
  assert.equal(b.api._internal.isStopped(), true);
  assert.equal(b.api._internal.isFinalStopped(), false);

  // trialCount 1→2→3→4（4回目でfinalStopped）まで、backoffのエスカレーションどおりtimerで進める。
  for (let i = 0; i < 3; i++) {
    b.advance(b.api._internal.RETRY_BACKOFF_MS[i] + 1000);
    await tick();
    await tick();
  }
  assert.equal(b.api._internal.isFinalStopped(), false);

  b.advance(b.api._internal.RETRY_BACKOFF_MS[3] + 1000);
  await tick();
  await tick();
  assert.equal(b.api._internal.isFinalStopped(), true);
  assert.equal(b.pendingTimerCount(), 0);

  // finalStopped後はどれだけ時間を進めても一切試行しない。
  const priorCalls = b.fetchCalls.length;
  b.advance(10 * 60 * 60 * 1000);
  await tick();
  assert.equal(b.fetchCalls.length, priorCalls);
});
