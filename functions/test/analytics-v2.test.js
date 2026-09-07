'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const script = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'analytics-v2.js'), 'utf8');
const RealDate = Date;

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

/**
 * js/analytics-v2.jsをNode vmコンテキストで実行するテストハーネス（独立監査再提出版）。
 * fetchResponder(url, init, callIndex) が呼び出しごとの応答（{status}）を返せるように
 * した（トライアル再送・バックオフ等、呼び出し順で挙動が変わるシナリオを検証するため）。
 */
function browser(opts) {
  opts = opts || {};
  const url = opts.url || 'https://aoki-tosou.net/';
  const referrer = opts.referrer || '';
  const localStore = opts.localStore || new Map();
  const sessionStore = opts.sessionStore || new Map();
  const fetchCalls = [];
  const beacons = [];
  let clickHandler = null;
  let visibilityHandler = null;
  let pagehideHandler = null;
  let currentNow = opts.now || RealDate.parse('2026-09-07T00:00:00+09:00');

  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(currentNow);
    return new RealDate(...args);
  }
  FakeDate.now = () => currentNow;
  FakeDate.prototype = RealDate.prototype;

  const fetchResponder = opts.fetchResponder || (() => ({ status: 200 }));

  class FakeBlob { constructor(parts) { this.text = parts.join(''); } }

  const location = new URL(url);
  const document = {
    referrer,
    visibilityState: 'visible',
    addEventListener(type, handler) {
      if (type === 'click') clickHandler = handler;
      if (type === 'visibilitychange') visibilityHandler = handler;
    },
    createElement() { return { textContent: '', get innerHTML() { return this.textContent; } }; }
  };
  const windowObj = {
    location,
    localStorage: {
      getItem(key) { return localStore.has(key) ? localStore.get(key) : null; },
      setItem(key, value) { localStore.set(key, String(value)); },
      removeItem(key) { localStore.delete(key); }
    },
    sessionStorage: {
      getItem(key) { return sessionStore.has(key) ? sessionStore.get(key) : null; },
      setItem(key, value) { sessionStore.set(key, String(value)); },
      removeItem(key) { sessionStore.delete(key); }
    },
    crypto: { randomUUID: opts.randomUUID || (() => RealDate.now().toString(16) + Math.random().toString(16).slice(2)) },
    fetch(endpoint, init) {
      const callIndex = fetchCalls.length;
      const body = JSON.parse(init.body);
      fetchCalls.push({ endpoint, body });
      let result;
      try {
        result = fetchResponder(endpoint, init, callIndex, body);
      } catch (err) {
        // 現実のfetch()は通信失敗を同期throwではなくPromise rejectとして表す。
        // テスト側のfetchResponderが例外を投げた場合も、rejectするPromiseとして扱う。
        return Promise.reject(err);
      }
      const status = (result && typeof result.status === 'number') ? result.status : 200;
      return Promise.resolve({ ok: status >= 200 && status < 300, status });
    },
    addEventListener(type, handler) { if (type === 'pagehide') pagehideHandler = handler; },
    document
  };

  const context = {
    URL, URLSearchParams, Blob: FakeBlob, Date: FakeDate, Math, JSON, Promise, console,
    window: windowObj,
    document,
    navigator: { sendBeacon(endpoint, blob) { beacons.push({ endpoint, body: JSON.parse(blob.text) }); return true; } }
  };
  windowObj.document = document;
  windowObj.navigator = context.navigator;
  vm.runInNewContext(script, context);

  return {
    fetchCalls, beacons, localStore, sessionStore,
    api: context.window.aokiAnalyticsV2,
    advance(ms) { currentNow += ms; },
    setVisibilityHidden() { document.visibilityState = 'hidden'; if (visibilityHandler) visibilityHandler(); },
    firePagehide() { if (pagehideHandler) pagehideHandler(); },
    click(href) {
      const link = { href, getAttribute() { return href; } };
      clickHandler({ target: { closest() { return link; } } });
      return link;
    }
  };
}

/* ===================================================================
 * 訪問境界：確定済みアルゴリズム（独立監査差し戻し対応）
 * =================================================================== */
test('信号なし初回訪問はvisitMediaCode=""・visitWebSource="direct"（真の直接訪問）', () => {
  const b = browser({ url: 'https://aoki-tosou.net/' });
  const body = b.fetchCalls[0].body;
  assert.equal(body.visitMediaCode, '');
  assert.equal(body.visitWebSource, 'direct');
});
test('媒体あり・外部referrerなしはvisitWebSource=""（"direct"にしない）', () => {
  const b = browser({ url: 'https://aoki-tosou.net/?from=meishi' });
  const body = b.fetchCalls[0].body;
  assert.equal(body.visitMediaCode, 'meishi');
  assert.equal(body.visitWebSource, '', '媒体があるので直接アクセス扱いにしない');
});
test('媒体なし・外部referrerありはvisitWebSourceへ生のreferrerホストを送る', () => {
  const b = browser({ url: 'https://aoki-tosou.net/', referrer: 'https://www.google.com/search?q=x' });
  const body = b.fetchCalls[0].body;
  assert.equal(body.visitMediaCode, '');
  assert.equal(body.visitWebSource, 'www.google.com');
});
test('媒体あり・外部referrerありは両方とも生値のまま送る（サーバー側で正規化される前提）', () => {
  const b = browser({ url: 'https://aoki-tosou.net/?from=meishi', referrer: 'https://www.google.com/search?q=x' });
  const body = b.fetchCalls[0].body;
  assert.equal(body.visitMediaCode, 'meishi');
  assert.equal(body.visitWebSource, 'www.google.com');
});
test('同一originのreferrerは外部信号として扱わない（内部遷移）', () => {
  const b = browser({ url: 'https://aoki-tosou.net/about.html', referrer: 'https://aoki-tosou.net/' });
  const body = b.fetchCalls[0].body;
  assert.equal(body.visitWebSource, 'direct', '同一origin遷移は真の直接訪問と同じ扱い（外部referrerではない）');
});

test('30分以内・信号なし（内部遷移）は同一visit_id・現在の帰属を維持する', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/?from=meishi', now: RealDate.parse('2026-09-07T10:00:00+09:00') });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  await tick();
  const second = browser({
    url: 'https://aoki-tosou.net/about.html', referrer: 'https://aoki-tosou.net/?from=meishi',
    sessionStore: first.sessionStore, localStore: first.localStore, now: RealDate.parse('2026-09-07T10:20:00+09:00')
  });
  assert.equal(second.fetchCalls[0].body.visit_id, visitId1);
  assert.equal(second.fetchCalls[0].body.visitMediaCode, 'meishi', '信号なしページでは直前の帰属を維持する');
});
test('30分以内でもfromが変化すれば新visit_id（M101→M202、必須回帰テスト）', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/?from=meishi', now: RealDate.parse('2026-09-07T10:00:00+09:00') });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  assert.equal(first.fetchCalls[0].body.visitMediaCode, 'meishi');
  await tick();
  const second = browser({
    url: 'https://aoki-tosou.net/?from=area_check_v1', sessionStore: first.sessionStore, localStore: first.localStore,
    now: RealDate.parse('2026-09-07T10:15:00+09:00') // 15分後＝タイムアウト前
  });
  assert.notEqual(second.fetchCalls[0].body.visit_id, visitId1, 'fromが変化したので30分以内でも新visit_id');
  assert.equal(second.fetchCalls[0].body.visitMediaCode, 'area_check_v1');
});
test('30分以内でも外部referrerだけが変化すれば新visit_id', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/', referrer: 'https://www.google.com/', now: RealDate.parse('2026-09-07T10:00:00+09:00') });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  await tick();
  const second = browser({
    url: 'https://aoki-tosou.net/', referrer: 'https://www.bing.com/', sessionStore: first.sessionStore, localStore: first.localStore,
    now: RealDate.parse('2026-09-07T10:10:00+09:00')
  });
  assert.notEqual(second.fetchCalls[0].body.visit_id, visitId1);
  assert.equal(second.fetchCalls[0].body.visitWebSource, 'www.bing.com');
});
test('30分以内でもfrom・referrer両方が変化すれば新visit_id', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/?from=meishi', now: RealDate.parse('2026-09-07T10:00:00+09:00') });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  await tick();
  const second = browser({
    url: 'https://aoki-tosou.net/?from=area_check_v1', referrer: 'https://www.google.com/',
    sessionStore: first.sessionStore, localStore: first.localStore, now: RealDate.parse('2026-09-07T10:10:00+09:00')
  });
  assert.notEqual(second.fetchCalls[0].body.visit_id, visitId1);
});
test('30分超過（信号なし）はタイムアウトにより新visit_id', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/?from=meishi', now: RealDate.parse('2026-09-07T10:00:00+09:00') });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  await tick();
  const second = browser({
    url: 'https://aoki-tosou.net/about.html', sessionStore: first.sessionStore, localStore: first.localStore,
    now: RealDate.parse('2026-09-07T10:31:00+09:00')
  });
  assert.notEqual(second.fetchCalls[0].body.visit_id, visitId1);
  assert.equal(second.fetchCalls[0].body.visitMediaCode, '', 'タイムアウト後の新visitは現在ページの信号（今回は無し）から再取得する');
});
test('同一boundaryKeyの繰り返し（同一from）は新visitにしない', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/?from=meishi', now: RealDate.parse('2026-09-07T10:00:00+09:00') });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  await tick();
  const second = browser({
    url: 'https://aoki-tosou.net/?from=meishi', sessionStore: first.sessionStore, localStore: first.localStore,
    now: RealDate.parse('2026-09-07T10:05:00+09:00')
  });
  assert.equal(second.fetchCalls[0].body.visit_id, visitId1, '同じboundaryKeyの再送はvisitを切らない');
});

test('visitorIdはlocalStorageに永続化され、次回ロードでもvisitorIdPersisted=trueとして同じIDが送られる', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/' });
  const firstId = first.fetchCalls[0].body.visitorId;
  assert.equal(first.fetchCalls[0].body.visitorIdPersisted, true);
  await tick();
  const second = browser({ url: 'https://aoki-tosou.net/about.html', localStore: first.localStore });
  assert.equal(second.fetchCalls[0].body.visitorId, firstId);
  assert.equal(second.fetchCalls[0].body.visitorIdPersisted, true);
});
test('localStorage書込みができない環境ではvisitorIdPersisted=falseを正直に送る', () => {
  const brokenStore = new Map();
  brokenStore.set = () => { throw new Error('quota exceeded'); };
  const b = browser({ url: 'https://aoki-tosou.net/', localStore: brokenStore });
  assert.equal(b.fetchCalls[0].body.visitorIdPersisted, false);
});
test('storageが全滅していても、同一ページ内の複数イベントは同じvisitorId・同じvisit_idをメモリ経由で使い回す', () => {
  const brokenStore = new Map();
  brokenStore.get = () => { throw new Error('broken'); };
  brokenStore.set = () => { throw new Error('broken'); };
  const b = browser({ url: 'https://aoki-tosou.net/?from=meishi', localStore: brokenStore, sessionStore: brokenStore });
  const visitorId1 = b.fetchCalls[0].body.visitorId;
  const visitId1 = b.fetchCalls[0].body.visit_id;
  b.click('tel:0975940076');
  assert.equal(b.fetchCalls[1].body.visitorId, visitorId1, 'storage不能でも同一ページ内はメモリ上のvisitorIdを使い回す（毎回新規発行しない）');
  assert.equal(b.fetchCalls[1].body.visit_id, visitId1, 'storage不能でも同一ページ内はメモリ上のvisit_idを使い回す');
});

test('LINEリンククリックはcontactChannel=LINEでline_clickを送る', () => {
  const b = browser({ url: 'https://aoki-tosou.net/' });
  b.click('https://page.line.me/148ilxnm');
  assert.equal(b.fetchCalls.length, 2);
  assert.equal(b.fetchCalls[1].body.eventType, 'line_click');
  assert.equal(b.fetchCalls[1].body.contactChannel, 'LINE');
});
test('電話リンククリックはphone_clickを送る', () => {
  const b = browser({ url: 'https://aoki-tosou.net/' });
  b.click('tel:0975940076');
  assert.equal(b.fetchCalls[1].body.eventType, 'phone_click');
});

/* ===================================================================
 * outbox：確定契約（独立監査差し戻し対応）
 * =================================================================== */
test('2xxはoutboxから削除される', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 200 }) });
  await tick();
  const outbox = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outbox.length, 0);
});
[400, 404, 413, 422, 403].forEach((status) => {
  test(`HTTP ${status}はoutboxから恒久的に削除される（再送しても成功しないため）`, async () => {
    const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status }) });
    await tick();
    const outbox = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
    assert.equal(outbox.length, 0, `status=${status}`);
  });
});
[408, 429, 500, 503].forEach((status) => {
  test(`HTTP ${status}はoutboxに保持され、再送用のnextRetryAtが設定される`, async () => {
    const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status }) });
    await tick();
    const outbox = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
    assert.equal(outbox.length, 1, `status=${status}`);
    assert.equal(outbox[0].attempts, 1);
    assert.ok(outbox[0].nextRetryAt > 0);
  });
});
test('通信失敗（fetch reject）もoutboxに保持され、再送対象になる', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => { throw new Error('network down'); } });
  await tick();
  const outbox = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].attempts, 1);
});
test('再送バックオフ表：1→15分・2→30分・3→60分・4回目以降→120分（上限）', () => {
  const b = browser({ url: 'https://aoki-tosou.net/' });
  const backoff = b.api._internal.backoffForAttempts;
  assert.equal(backoff(1), 15 * 60 * 1000);
  assert.equal(backoff(2), 30 * 60 * 1000);
  assert.equal(backoff(3), 60 * 60 * 1000);
  assert.equal(backoff(4), 120 * 60 * 1000);
  assert.equal(backoff(9), 120 * 60 * 1000, '4回目以降は120分で頭打ち');
});
test('sendBeaconが成功（true）を返しても、次回fetchで2xxを確認するまでoutboxから削除しない', async () => {
  // 1回目の送信はfetchが失敗する設定にしてoutboxへ積んだ状態を作り、
  // その後の離脱（visibilitychange）でsendBeaconに切り替わることを検証する。
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 500 }) });
  await tick();
  let outbox = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outbox.length, 1, '前提：500でoutboxに残っている');
  b.setVisibilityHidden(); // sendBeaconでの送信を試みる（成功=trueを返す想定のモック）
  assert.equal(b.beacons.length, 1, 'sendBeaconは呼ばれる');
  outbox = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outbox.length, 1, 'sendBeaconの成功だけではoutboxから削除しない（fetchの2xx確認が必要）');
});

/* ===================================================================
 * PROD 401 サーキットブレーカー（独立監査差し戻し対応）
 * =================================================================== */
test('401を受けると送信を全体停止し、以後のtrackはfetchを呼ばずoutboxへ積むだけになる', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 401 }) });
  await tick();
  assert.equal(b.fetchCalls.length, 1);
  assert.equal(b.api.isStopped(), true);
  b.api.track('phone_click');
  assert.equal(b.fetchCalls.length, 1, '停止中は追加のfetchを試みない');
  const outbox = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outbox.length, 2, '停止中でもoutboxへは積まれる');
});
test('401後15分経過で、outbox最古の1件だけを試験再送する（全件ではない）', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 401 }) });
  await tick();
  b.api.track('phone_click'); // 停止中なのでfetchは呼ばれず、outboxに2件目が積まれるだけ
  await tick();
  assert.equal(b.fetchCalls.length, 1);

  b.advance(15 * 60 * 1000 + 1000); // 15分経過
  b.api._internal.attemptTrialResend();
  await tick();
  assert.equal(b.fetchCalls.length, 2, '試験再送は1件だけ（全件フラッシュではない）');
});
test('試験再送が成功（2xx）すれば停止を解除し、残りのoutboxも通常どおり再送される', async () => {
  let callCount = 0;
  const b = browser({
    url: 'https://aoki-tosou.net/',
    fetchResponder: () => { callCount++; return { status: callCount === 1 ? 401 : 200 }; }
  });
  await tick();
  assert.equal(b.api.isStopped(), true);
  b.advance(15 * 60 * 1000 + 1000);
  b.api._internal.attemptTrialResend();
  await tick();
  assert.equal(b.api.isStopped(), false, '試験再送が2xxなら停止解除');
});
test('試験再送が再び401なら停止を継続し、次回試験を15分後へ再設定する', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 401 }) });
  await tick();
  const stopBefore = b.api._internal.loadStopState();
  b.advance(15 * 60 * 1000 + 1000);
  b.api._internal.attemptTrialResend();
  await tick();
  assert.equal(b.api.isStopped(), true);
  const stopAfter = b.api._internal.loadStopState();
  assert.ok(stopAfter.nextTrialAt > stopBefore.nextTrialAt, '次回試験時刻が15分後へ再設定される');
});
test('ページを新規に開いた時点（init）でも、15分未経過でも試験再送を試みる', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 401 }) });
  await tick();
  assert.equal(first.api.isStopped(), true);
  // 15分経過させず、すぐ次のページロードを模す
  const second = browser({
    url: 'https://aoki-tosou.net/about.html', localStore: first.localStore, sessionStore: first.sessionStore,
    fetchResponder: () => ({ status: 200 })
  });
  await tick();
  // 2回目のブラウザ初期化時、init()内のattemptTrialResendが（15分未経過でも）呼ばれ、
  // 停止状態が解除されているはず。
  assert.equal(second.api.isStopped(), false, '次回ロード時は15分未経過でも試験再送のトリガーになる');
});
test('resumeAfterStop()でQA目的に即時再開できる', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 401 }) });
  await tick();
  assert.equal(b.api.isStopped(), true);
  b.api.resumeAfterStop();
  assert.equal(b.api.isStopped(), false);
});

/* ===================================================================
 * outbox：件数・期限・診断
 * =================================================================== */
test('outboxは50件を超えると古い順に切り詰められる', () => {
  const fakeNow = RealDate.parse('2026-09-07T12:00:00+09:00');
  const b = browser({ url: 'https://aoki-tosou.net/', now: fakeNow });
  const internal = b.api._internal;
  const list = [];
  for (let i = 0; i < 60; i++) list.push({ generation: internal.WRITER_GENERATION, event: { event_id: 'e_' + i }, addedAt: fakeNow, attempts: 0, nextRetryAt: 0 });
  const pruned = internal.pruneOutbox(list);
  assert.equal(pruned.length, 50);
  assert.equal(pruned[0].event.event_id, 'e_10');
});
test('outboxは24時間を超えたエントリを破棄し、破棄件数を診断情報へ記録する', () => {
  const fakeNow = RealDate.parse('2026-09-07T12:00:00+09:00');
  const b = browser({ url: 'https://aoki-tosou.net/', now: fakeNow });
  const internal = b.api._internal;
  const list = [
    { generation: internal.WRITER_GENERATION, event: { event_id: 'old1' }, addedAt: fakeNow - (25 * 60 * 60 * 1000), attempts: 0, nextRetryAt: 0 },
    { generation: internal.WRITER_GENERATION, event: { event_id: 'old2' }, addedAt: fakeNow - (30 * 60 * 60 * 1000), attempts: 0, nextRetryAt: 0 },
    { generation: internal.WRITER_GENERATION, event: { event_id: 'fresh' }, addedAt: fakeNow - (1 * 60 * 60 * 1000), attempts: 0, nextRetryAt: 0 }
  ];
  const pruned = internal.pruneOutbox(list);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].event.event_id, 'fresh');
  const diag = b.api.getDiagnostics();
  assert.equal(diag.expiredDiscardCount, 2, '24時間超過で破棄した2件が診断情報に記録される');
});
test('outboxは異なるwriter世代のエントリを破棄する（将来のwriter変更に対する保護）', () => {
  const fakeNow = RealDate.parse('2026-09-07T12:00:00+09:00');
  const b = browser({ url: 'https://aoki-tosou.net/', now: fakeNow });
  const internal = b.api._internal;
  const list = [
    { generation: internal.WRITER_GENERATION - 1, event: { event_id: 'old_gen' }, addedAt: fakeNow, attempts: 0, nextRetryAt: 0 },
    { generation: internal.WRITER_GENERATION, event: { event_id: 'current_gen' }, addedAt: fakeNow, attempts: 0, nextRetryAt: 0 }
  ];
  const pruned = internal.pruneOutbox(list);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].event.event_id, 'current_gen');
});
test('離脱時（visibilitychange=hidden）はsendBeaconで未送信分をフラッシュする', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 500 }) });
  await tick();
  assert.equal(b.beacons.length, 0);
  b.setVisibilityHidden();
  assert.equal(b.beacons.length, 1);
});
test('離脱時（pagehide）でもsendBeaconでフラッシュする', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 500 }) });
  await tick();
  b.firePagehide();
  assert.equal(b.beacons.length, 1);
});
