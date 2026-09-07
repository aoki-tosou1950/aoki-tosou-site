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

  class FakeBlob { constructor(parts, options) { this.text = parts.join(''); this.type = (options && options.type) || ''; } }

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
      // 監査差し戻し（独立監査再提出R7）#5：window.fetch(...)の呼び出し自体が
      // Promiseを返す前に同期的に例外を投げるケース（CSP違反等で稀に発生し得る）を
      // 検証するためのオプション。opts.syncThrowFetchが真なら、ここで実際に同期throwする
      // （sendViaFetch側の外側try/catchが正しくattempts/nextRetryAtを更新することを
      // 確認するテスト専用の経路。通常のfetchResponder経由の失敗はPromise.rejectのまま）。
      if (opts.syncThrowFetch) { throw new Error('synchronous fetch failure (test)'); }
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
    navigator: { sendBeacon(endpoint, blob) { beacons.push({ endpoint, body: JSON.parse(blob.text), contentType: blob.type }); return true; } }
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

/* ---- 独立監査再提出R6 #3：同一from・外部referrerだけ消える特則 ---- */
test('R6#3 シナリオA：30分以内に同じfromが再度届くが今回は外部referrerが無い場合、同一visit_idを継続し元のmediaCode・webSourceを両方維持する', async () => {
  const first = browser({
    url: 'https://aoki-tosou.net/?from=meishi', referrer: 'https://www.google.com/search?q=x',
    now: RealDate.parse('2026-09-07T10:00:00+09:00')
  });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  assert.equal(first.fetchCalls[0].body.visitMediaCode, 'meishi');
  assert.equal(first.fetchCalls[0].body.visitWebSource, 'www.google.com');
  await tick();
  const second = browser({
    // 同じfrom=meishiがURLに付いているが、今回のreferrerは同一origin遷移
    // （外部referrerではない＝currentSignal()はreferrerHost=nullを返す）。
    url: 'https://aoki-tosou.net/?from=meishi', referrer: 'https://aoki-tosou.net/?from=meishi',
    sessionStore: first.sessionStore, localStore: first.localStore, now: RealDate.parse('2026-09-07T10:20:00+09:00')
  });
  assert.equal(second.fetchCalls[0].body.visit_id, visitId1, '同じfromで信号が弱くなっただけなので同一visitを継続する（境界キー文字列の単純比較だけで新visitにしない）');
  assert.equal(second.fetchCalls[0].body.visitMediaCode, 'meishi', 'mediaCodeを維持する');
  assert.equal(second.fetchCalls[0].body.visitWebSource, 'www.google.com', '元の外部referrer由来のwebSourceをリセットせず維持する（監査差し戻しR6 #3の核心）');
});
test('R6#3 シナリオB：タイムアウト後に同じfrom・referrerなしが届いた場合は特則を適用せず新visit_id・webSource=""', async () => {
  const first = browser({
    url: 'https://aoki-tosou.net/?from=meishi', referrer: 'https://www.google.com/search?q=x',
    now: RealDate.parse('2026-09-07T10:00:00+09:00')
  });
  const visitId1 = first.fetchCalls[0].body.visit_id;
  await tick();
  const second = browser({
    url: 'https://aoki-tosou.net/?from=meishi',
    sessionStore: first.sessionStore, localStore: first.localStore, now: RealDate.parse('2026-09-07T10:31:00+09:00') // 30分超過
  });
  assert.notEqual(second.fetchCalls[0].body.visit_id, visitId1, 'タイムアウト後は特則を適用せず新visitを開始する');
  assert.equal(second.fetchCalls[0].body.visitMediaCode, 'meishi');
  assert.equal(second.fetchCalls[0].body.visitWebSource, '', 'タイムアウト後の新visitは現在ページの信号（媒体はあるが外部referrerは無い）から再取得するのでwebSourceは空');
});

/* ---- 独立監査再提出R6 #10：referrerHostの完全削除 ---- */
test('R6#10：送信payloadに"referrerHost"キーが一切存在しない（値が空文字ではなく、キー自体が無い）', () => {
  // 監査差し戻し：前回「削除した」と報告していたが、実際にはbuildEvent()の返却
  // オブジェクトにreferrerHost: safeReferrerHost()が残ったままだった（削除漏れ）。
  // 空文字が送られる状態と「キー自体が存在しない」状態は別物であり、hasOwnPropertyで
  // 厳密に確認する（JSON.stringify後の文字列に"referrerHost"という部分文字列が
  // 含まれないことも合わせて確認し、キー名の書き方を変えて紛れ込ませていないかも見る）。
  const b = browser({ url: 'https://aoki-tosou.net/?from=meishi', referrer: 'https://www.google.com/search?q=x' });
  const body = b.fetchCalls[0].body;
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'referrerHost'), false, 'referrerHostキー自体が存在しないこと');
  assert.equal(JSON.stringify(body).indexOf('referrerHost'), -1, 'シリアライズ後の送信payload文字列にも"referrerHost"という部分文字列が一切含まれないこと');
});
test('R6#10：line_click／phone_clickイベントの送信payloadにも"referrerHost"キーが存在しない', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', referrer: 'https://www.google.com/' });
  b.api.track('line_click', { contactChannel: 'LINE' });
  await tick();
  const body = b.fetchCalls[b.fetchCalls.length - 1].body;
  assert.equal(body.eventType, 'line_click');
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'referrerHost'), false);
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
test('R7#5：window.fetch(...)呼び出し自体が同期的に例外を投げた場合も、.catch()分岐と同じくattempts/nextRetryAtを更新する', async () => {
  // 訂正：以前はsendViaFetchの外側try/catch（window.fetch(...)自体の同期throwを捕まえる方）が
  // onSettled('exception')を呼ぶだけでattempts/nextRetryAtを一切更新しておらず、このitemの
  // 通常再送スケジュールが進まないまま取り残される欠陥だった。
  const b = browser({ url: 'https://aoki-tosou.net/', syncThrowFetch: true });
  await tick();
  const outbox = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outbox.length, 1, '同期例外でもitem自体はoutboxに残る（削除しない）');
  assert.equal(outbox[0].attempts, 1, '同期例外でも.catch()分岐と同じくattemptsが更新される');
  assert.ok(outbox[0].nextRetryAt > 0, '同期例外でも.catch()分岐と同じくnextRetryAtが設定される（通常の再送スケジュールに乗る）');
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
test('R6#9：試験再送が再び401なら停止を継続し、trialCountを1つ進めて次回試験を30分後（15→30分へエスカレート、15分固定ではない）へ再設定する', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 401 }) });
  await tick();
  const stopBefore = b.api._internal.loadStopState();
  assert.equal(stopBefore.trialCount, 0, '停止開始直後はtrialCount=0');
  b.advance(15 * 60 * 1000 + 1000);
  b.api._internal.attemptTrialResend();
  await tick();
  assert.equal(b.api.isStopped(), true);
  const stopAfter = b.api._internal.loadStopState();
  assert.equal(stopAfter.trialCount, 1, '1回目の試験再送失敗でtrialCountが1になる');
  assert.equal(stopAfter.finalStopped, false, '1回目の失敗だけではfinalStoppedにならない');
  assert.equal(stopAfter.nextTrialAt, stopBefore.nextTrialAt + 1000 + 30 * 60 * 1000, '次回試験時刻は15分固定ではなく30分後へエスカレートする（15→30→60→120分）');
});
test('R7#5訂正：試験再送が恒久的4xx（例：400）を返した場合、401のtrialCountは進めない（401とは無関係の失敗のため）。停止状態は維持し、対象エントリだけ削除する', async () => {
  // 訂正：R6版のこのテストは「恒久4xxもtrialCountを1つ進める」ことを期待していたが、
  // これは監査差し戻しR7・項目5が指摘した誤りそのものだった（401の試行回数を、401とは
  // 無関係の恒久4xxが消費してしまう）。trialCountが進まない（0のまま）ことを正しい
  // 期待値へ訂正する（弱体化ではなく、指摘された誤りの是正）。
  const b = browser({
    url: 'https://aoki-tosou.net/',
    fetchResponder: (url, init, callIndex) => ({ status: callIndex === 0 ? 401 : 400 })
  });
  await tick();
  assert.equal(b.api.isStopped(), true);
  const before = b.api._internal.loadStopState();
  const outboxBefore = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outboxBefore.length, 1, '試験対象は最古の1件のみ');
  b.advance(15 * 60 * 1000 + 1000);
  b.api._internal.attemptTrialResend();
  await tick();
  assert.equal(b.api.isStopped(), true, '恒久4xxでも停止状態は継続する（successでなければクリアしない）');
  const state = b.api._internal.loadStopState();
  assert.equal(state.trialCount, 0, '恒久4xx（401とは無関係の失敗）はtrialCountを進めない');
  assert.equal(state.finalStopped, false);
  assert.equal(state.nextTrialAt, before.nextTrialAt + 1000 + 15 * 60 * 1000, '次回試験時刻はエスカレートせず同じ15分間隔で再設定される（rescheduleTrialWait）');
  const outboxAfter = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outboxAfter.length, 0, '恒久4xxを返した最古エントリ自体は削除される（sendViaFetchのpermanent分岐）');
});
test('R7#5訂正：試験再送が一時的失敗（例：503）を返した場合も、401のtrialCountは進めない。対象エントリは削除されず保持される', async () => {
  const b = browser({
    url: 'https://aoki-tosou.net/',
    fetchResponder: (url, init, callIndex) => ({ status: callIndex === 0 ? 401 : 503 })
  });
  await tick();
  const before = b.api._internal.loadStopState();
  b.advance(15 * 60 * 1000 + 1000);
  b.api._internal.attemptTrialResend();
  await tick();
  assert.equal(b.api.isStopped(), true);
  const state = b.api._internal.loadStopState();
  assert.equal(state.trialCount, 0, '一時的失敗（5xx。401とは無関係）はtrialCountを進めない');
  assert.equal(state.nextTrialAt, before.nextTrialAt + 1000 + 15 * 60 * 1000, '次回試験時刻はエスカレートせず同じ15分間隔で再設定される');
  const outboxAfter = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outboxAfter.length, 1, '一時的失敗のエントリは削除されず保持される（次回同じエントリを再試行）');
});
test('R7#5：永久エラー（恒久4xx）が4件連続しても、401の試行回数を一切消費しないためfinalStoppedにはならない（401とは無関係のエラーで上限に達しない）', async () => {
  const b = browser({
    url: 'https://aoki-tosou.net/',
    // 初回401で停止開始、以後の試験再送は常に400（恒久4xx）を返す。
    fetchResponder: (url, init, callIndex) => ({ status: callIndex === 0 ? 401 : 400 })
  });
  await tick();
  assert.equal(b.api.isStopped(), true);
  // 試験対象を4件確保する（1件だと1回目の試験でpermanent削除されてしまい、2回目以降は
  // 「送るものが無い」経路になって「4回とも実際に400を受け取った」ことの検証にならない）。
  b.api.track('phone_click');
  b.api.track('phone_click');
  b.api.track('phone_click');
  await tick();
  const outboxSeeded = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outboxSeeded.length, 4, '停止中でも試験対象4件がoutboxに積まれている（page_view 1件＋phone_click 3件）');
  for (let i = 0; i < 4; i++) {
    b.advance(15 * 60 * 1000 + 1000); // rescheduleTrialWaitは常に15分固定（エスカレートしない）なので毎回同じ待機で足りる
    b.api._internal.attemptTrialResend();
    await tick();
  }
  const state = b.api._internal.loadStopState();
  assert.equal(state.trialCount, 0, '4回とも恒久4xx（401とは無関係）だったためtrialCountは0のまま');
  assert.equal(state.finalStopped, false, '401の試行回数を消費していないためfinalStoppedにならない（上限4回に達しない）');
  assert.equal(b.api.isStopped(), true, '停止状態自体は維持される（成功していないため）');
  const outboxAfter = JSON.parse(b.localStore.get('aoki_analytics_v2_outbox') || '[]');
  assert.equal(outboxAfter.length, 0, '4件とも恒久4xxで個別に削除された（4回とも実際に別々のエントリへ試行したことの確認）');
});
test('R6#9：試験再送は15→30→60→120分とエスカレートし、4回連続失敗するとfinalStopped=trueになり以後は時間が経っても自動試験しない（上限4回・確定契約）', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 401 }) }); // 常に401（初回＋4回とも失敗）
  await tick();
  let state = b.api._internal.loadStopState();
  assert.equal(state.trialCount, 0);

  const expectedIntervalsMin = [15, 30, 60, 120]; // 各試験（1〜4回目）を行うまでの待機分
  for (let i = 0; i < 4; i++) {
    b.advance(expectedIntervalsMin[i] * 60 * 1000 + 1000);
    b.api._internal.attemptTrialResend();
    await tick();
    state = b.api._internal.loadStopState();
    if (i < 3) {
      assert.equal(state.trialCount, i + 1, `${i + 1}回目の試験失敗後、trialCount=${i + 1}`);
      assert.equal(state.finalStopped, false, `${i + 1}回目まではfinalStoppedにならない`);
    } else {
      assert.equal(state.trialCount, 4, '4回目の試験失敗でtrialCount=4');
      assert.equal(state.finalStopped, true, '4回失敗したらfinalStopped=trueになる（無制限試験の禁止・上限4回の確定契約）');
      assert.equal(state.nextTrialAt, null, 'finalStopped後はnextTrialAtが無い（自動試験を予定しない）');
    }
  }
  const fetchCountAtFinal = b.fetchCalls.length;
  b.advance(999 * 60 * 60 * 1000); // 999時間経過させても
  b.api._internal.attemptTrialResend();
  await tick();
  assert.equal(b.fetchCalls.length, fetchCountAtFinal, 'finalStopped後は時間がいくら経過しても自動試験しない（fetch回数が増えない）');
  assert.equal(b.api.isStopped(), true, 'finalStopped後もisStopped()はtrueのまま（QAのresumeAfterStop()だけが復帰手段）');
});
test('R6#9訂正：ページを新規に開いても（何度リロードしても）、nextTrialAtを過ぎていなければ試験再送しない（旧force=true仕様の廃止＝無制限試験の禁止）', async () => {
  const first = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 401 }) });
  await tick();
  assert.equal(first.api.isStopped(), true);
  assert.equal(first.fetchCalls.length, 1);
  // 15分経過させず、すぐ次のページロードを模す（何度リロードしても同じはず）。
  const second = browser({
    url: 'https://aoki-tosou.net/about.html', localStore: first.localStore, sessionStore: first.sessionStore,
    fetchResponder: () => ({ status: 200 })
  });
  await tick();
  assert.equal(second.api.isStopped(), true, '15分未経過のページ再読み込みは試験再送のトリガーにならない（旧仕様＝force=trueは誤りだったため廃止）');
  assert.equal(second.fetchCalls.length, 0, '停止中の新規ページロードはfetchを一切呼ばない（試験再送も通常送信も行わない。track()はoutboxへ積むだけ）');
  const secondReload = browser({
    url: 'https://aoki-tosou.net/contact.html', localStore: first.localStore, sessionStore: first.sessionStore,
    fetchResponder: () => ({ status: 200 })
  });
  await tick();
  assert.equal(secondReload.api.isStopped(), true, '2回目のリロードでもまだ試験されない（何度リロードしても回数制限をバイパスできない）');
  assert.equal(secondReload.fetchCalls.length, 0);
});
test('resumeAfterStop()でQA目的に即時再開できる（trialCount・finalStoppedを含む状態を完全に破棄する）', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 401 }) });
  await tick();
  assert.equal(b.api.isStopped(), true);
  b.api.resumeAfterStop();
  assert.equal(b.api.isStopped(), false);
  assert.equal(b.api._internal.loadStopState(), null, 'resumeAfterStop後は停止状態（trialCount・finalStopped含む）そのものが存在しない');
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
test('R7#6：sendBeaconのBlobはtext/plain（CORS safelisted）を使う（application/jsonではない。ENDPOINTは別オリジンのためcross-origin送信になる）', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 500 }) });
  await tick();
  b.setVisibilityHidden();
  assert.equal(b.beacons.length, 1);
  assert.equal(b.beacons[0].contentType, 'text/plain', 'application/jsonはCORS safelistedではなく、preflightできないsendBeaconでは不安定になり得るためtext/plainを使う');
  assert.equal(b.beacons[0].body.eventType, 'page_view', '送信内容自体（JSON文字列）はContent-Type変更の影響を受けず無変更のまま');
});
