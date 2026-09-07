'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const script = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'analytics-v2.js'), 'utf8');
const RealDate = Date;

/** track()の送信結果（fetch().then(...)）はマイクロタスクとして非同期に解決するため、
 * 同じstorageを共有する2回目のbrowser()呼び出しを、1回目の送信結果（outboxからの
 * dequeue）が確定する前に行うと、1回目の未確定outboxエントリが2回目のinit()内で
 * flushOutboxViaFetch()により「先に」再送され、fetchCalls配列のインデックスがずれる
 * （実際のブラウザでも起こり得る正しい競合状態だが、テストでは意図的に1tick待って
 * 「前回の送信が確定してから次のページ遷移が起きた」状態にそろえる）。 */
function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

/**
 * js/analytics-v2.jsをNode vmコンテキストで実行するテストハーネス
 * （functions/test/analytics.test.jsのV1版パターンを踏襲・拡張）。
 * - localStorage/sessionStorageは呼び出し元からMapを渡せる（複数「ページロード」間で
 *   永続化される状態＝visitorId等と、タブを閉じたらリセットされる状態＝visit状態を
 *   それぞれ独立に検証するため）。
 * - fetchは呼び出し元が用意したレスポンダ関数で応答を制御できる（200/401/network error）。
 * - Date.nowは呼び出し元が指定した起点からteatが明示的にadvance()するまで固定される
 *   （30分visit境界・24時間outbox期限のテストのために実時間を待たない）。
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

  const fetchResponder = opts.fetchResponder || (() => Promise.resolve({ ok: true, status: 200 }));

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
      fetchCalls.push({ endpoint, body: JSON.parse(init.body) });
      return fetchResponder(endpoint, init);
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

test('ページ表示でschemaVersion:2のpage_viewをfetch優先で送る', () => {
  const b = browser({ url: 'https://aoki-tosou.net/?from=meishi' });
  assert.equal(b.fetchCalls.length, 1);
  assert.equal(b.beacons.length, 0, '初回page_viewはfetchで送られ、sendBeaconは使わない');
  const body = b.fetchCalls[0].body;
  assert.equal(body.schemaVersion, 2);
  assert.equal(body.eventType, 'page_view');
  assert.match(body.event_id, /^[A-Za-z0-9_-]{12,100}$/);
  assert.match(body.visit_id, /^[A-Za-z0-9_-]{16,100}$/);
  assert.equal(typeof body.occurredAt, 'number');
  assert.ok(Number.isInteger(body.occurredAt));
  assert.equal(body.visitMediaCode, 'meishi');
});

test('visitorIdはlocalStorageに永続化され、次回ロードでもvisitorIdPersisted=trueとして同じIDが送られる', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/' });
  const firstId = first.fetchCalls[0].body.visitorId;
  assert.equal(first.fetchCalls[0].body.visitorIdPersisted, true);
  await tick(); // 1回目の送信確定（outbox dequeue）を待ってから次のページ遷移を模す

  const second = browser({ url: 'https://aoki-tosou.net/about.html', localStore: first.localStore });
  assert.equal(second.fetchCalls[0].body.visitorId, firstId, '同一localStorageなら同じvisitorIdが再利用される');
  assert.equal(second.fetchCalls[0].body.visitorIdPersisted, true);
});

test('localStorage書込みができない環境ではvisitorIdPersisted=falseを正直に送る', () => {
  // 最初から書込み不可のlocalStore（新規visitorId自体の永続化が失敗するケース）で検証する。
  // 既にvisitorIdが書き込まれた後のstoreへ差し替えても、getOrCreateVisitorIdは既存値を
  // 読むだけでsetItemを呼ばないため、書込み失敗を検知できない（意図的にこの順序で検証する）。
  const brokenStore = new Map();
  brokenStore.set = () => { throw new Error('quota exceeded'); };
  const b = browser({ url: 'https://aoki-tosou.net/', localStore: brokenStore });
  assert.equal(b.fetchCalls[0].body.visitorIdPersisted, false);
});

test('30分以内の2回目のイベントは同一visit_id・同一帰属を維持する（sessionStorage共有）', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/?from=meishi', now: RealDate.parse('2026-09-07T10:00:00+09:00') });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  await tick();

  // 別ページへ遷移（fromパラメータなし）だが同一session・29分後
  const second = browser({
    url: 'https://aoki-tosou.net/about.html', sessionStore: first.sessionStore, localStore: first.localStore,
    now: RealDate.parse('2026-09-07T10:29:00+09:00')
  });
  assert.equal(second.fetchCalls[0].body.visit_id, visitId1, '30分以内は同一visit_id');
  assert.equal(second.fetchCalls[0].body.visitMediaCode, 'meishi', '2ページ目でも最初の帰属（meishi）を維持する（再取得しない）');
});

test('30分を超える無操作後は新しいvisit_id・新しい帰属で境界を切る', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/?from=meishi', now: RealDate.parse('2026-09-07T10:00:00+09:00') });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  await tick();

  const second = browser({
    url: 'https://aoki-tosou.net/?from=area_check_v1', sessionStore: first.sessionStore, localStore: first.localStore,
    now: RealDate.parse('2026-09-07T10:31:00+09:00') // 31分後＝タイムアウト超過
  });
  assert.notEqual(second.fetchCalls[0].body.visit_id, visitId1, '30分超過後は新しいvisit_id');
  assert.equal(second.fetchCalls[0].body.visitMediaCode, 'area_check_v1', '新しいvisitでは帰属を再取得する');
});

test('リファラなしはvisitWebSource=direct、外部リファラはホスト名をそのまま送る（サーバー側で正規化される前提）', () => {
  const direct = browser({ url: 'https://aoki-tosou.net/' });
  assert.equal(direct.fetchCalls[0].body.visitWebSource, 'direct');

  const external = browser({ url: 'https://aoki-tosou.net/', referrer: 'https://www.google.com/search?q=x' });
  assert.equal(external.fetchCalls[0].body.visitWebSource, 'www.google.com');
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

test('fetchが失敗（reject）してもsendBeaconは呼ばれず、次回ロード時に同一event_idで再送される', () => {
  const first = browser({
    url: 'https://aoki-tosou.net/',
    fetchResponder: () => Promise.reject(new Error('network error'))
  });
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    assert.equal(first.beacons.length, 0, 'fetch失敗時にsendBeaconへフォールバックしない（初回track内では使わない設計）');
    const firstEventId = first.fetchCalls[0].body.event_id;

    const second = browser({ url: 'https://aoki-tosou.net/', localStore: first.localStore, sessionStore: first.sessionStore });
    // 2回目のロードでは: 1) outbox flush（前回の失敗分の再送）→2) 新規page_view の順で2回fetchが呼ばれる
    assert.equal(second.fetchCalls.length, 2);
    assert.equal(second.fetchCalls[0].body.event_id, firstEventId, '再送は新しいevent_idを発行せず同一event_idのまま行う');
  });
});

test('fetchが200を返せばoutboxから外れ、次回ロードで再送されない', () => {
  const first = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => Promise.resolve({ ok: true, status: 200 }) });
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    const outboxRaw = first.localStore.get('aoki_analytics_v2_outbox');
    const outbox = JSON.parse(outboxRaw || '[]');
    assert.equal(outbox.length, 0, '200応答後はoutboxが空になる');
  });
});

test('401を受けると以後の送信を停止し（outboxへは積むがfetchは呼ばない）、resumeAfterStop()で再開する', () => {
  const first = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => Promise.resolve({ ok: false, status: 401 }) });
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    assert.equal(first.fetchCalls.length, 1);
    // 401後の2件目のtrackはfetchを呼ばない（停止中）
    first.api.track('phone_click');
    assert.equal(first.fetchCalls.length, 1, '401後は追加のfetchを試みない');
    const outbox = JSON.parse(first.localStore.get('aoki_analytics_v2_outbox') || '[]');
    assert.equal(outbox.length, 2, '停止中でもoutboxへは積まれている（送信は試みないだけ）');

    first.api.resumeAfterStop();
    assert.equal(first.api.isStopped(), false);
  });
});

test('outboxは50件を超えると古い順に切り詰められる', () => {
  const fakeNow = RealDate.parse('2026-09-07T12:00:00+09:00');
  const b = browser({ url: 'https://aoki-tosou.net/', now: fakeNow });
  const internal = b.api._internal;
  const list = [];
  for (let i = 0; i < 60; i++) {
    list.push({ generation: internal.WRITER_GENERATION, event: { event_id: 'e_' + i }, addedAt: fakeNow });
  }
  const pruned = internal.pruneOutbox(list);
  assert.equal(pruned.length, 50);
  assert.equal(pruned[0].event.event_id, 'e_10', '古い10件が切り捨てられ、直近50件が残る');
});

test('outboxは24時間を超えたエントリを破棄する', () => {
  // pruneOutbox内部はvmコンテキストのDate.now()（browser()が固定したfake now）を使うため、
  // このテストファイル自身のグローバルDate.now()（実時刻）を基準にaddedAtを計算すると、
  // fakeNowと実時刻のズレ分だけ意図しない差分が生じる。browser()へ明示的に渡したnowと
  // 同じ基準値からaddedAtを計算することで、この2つの時計を確実に一致させる。
  const fakeNow = RealDate.parse('2026-09-07T12:00:00+09:00');
  const b = browser({ url: 'https://aoki-tosou.net/', now: fakeNow });
  const internal = b.api._internal;
  const list = [
    { generation: internal.WRITER_GENERATION, event: { event_id: 'old' }, addedAt: fakeNow - (25 * 60 * 60 * 1000) },
    { generation: internal.WRITER_GENERATION, event: { event_id: 'fresh' }, addedAt: fakeNow - (1 * 60 * 60 * 1000) }
  ];
  const pruned = internal.pruneOutbox(list);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].event.event_id, 'fresh');
});

test('outboxは異なるwriter世代のエントリを破棄する（将来のwriter変更に対する保護）', () => {
  const fakeNow = RealDate.parse('2026-09-07T12:00:00+09:00');
  const b = browser({ url: 'https://aoki-tosou.net/', now: fakeNow });
  const internal = b.api._internal;
  const list = [
    { generation: internal.WRITER_GENERATION - 1, event: { event_id: 'old_gen' }, addedAt: fakeNow },
    { generation: internal.WRITER_GENERATION, event: { event_id: 'current_gen' }, addedAt: fakeNow }
  ];
  const pruned = internal.pruneOutbox(list);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].event.event_id, 'current_gen');
});

test('離脱時（visibilitychange=hidden）はsendBeaconで未送信分をフラッシュする', () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => Promise.reject(new Error('network error')) });
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    assert.equal(b.beacons.length, 0);
    b.setVisibilityHidden();
    assert.equal(b.beacons.length, 1, 'visibilitychange=hiddenでoutbox中のイベントがsendBeaconで送られる');
    assert.equal(b.beacons[0].body.event_id, b.fetchCalls[0].body.event_id, '同一event_idのまま送られる');
  });
});

test('離脱時（pagehide）でもsendBeaconでフラッシュする', () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => Promise.reject(new Error('network error')) });
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    b.firePagehide();
    assert.equal(b.beacons.length, 1);
  });
});
