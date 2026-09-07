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
      // 独立監査再提出R8・項目5：opts.brokenLocalStorageWriteが真の場合、setItem()自体は
      // 例外を投げず「成功したかのように」振る舞うが、実際に保存される値は要求された
      // 値とは異なる（＝一部のブラウザ・プライバシーモード等で実際に起こり得る
      // 「書込みは成功するが読戻しが不一致になる」ケースを再現するテスト専用フック）。
      setItem(key, value) {
        if (opts.brokenLocalStorageWrite) { localStore.set(key, String(value) + '_SILENTLY_CORRUPTED'); return; }
        localStore.set(key, String(value));
      },
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

/* =====================================================================
 * 独立監査再提出R8・項目5：visitorIdPersistedの読戻し確認。
 * 以前はsafeLocalSetが例外を投げなかっただけでpersisted=trueにしていたため、
 * setItem()自体は「成功したように振る舞う」が実際には書き込まれない・別の値に
 * 化ける、という一部のブラウザ実装（プライバシーモード・サードパーティストレージ
 * 分割等）で実際に起こり得るケースを、誤ってpersisted=true（＝サーバー側で
 * hashReliable=trueの根拠になる）として送ってしまっていた。setItem後にgetItemで
 * 読み戻し、書いた値と完全一致した場合だけtrueとする修正を検証する。
 * ===================================================================== */
test('R8#5：setItemは例外を投げないが読戻しが書いた値と不一致（サイレント破損）だと、visitorIdPersisted=falseを正直に送る', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/', brokenLocalStorageWrite: true });
  await tick();
  assert.equal(b.fetchCalls.length, 1);
  assert.equal(b.fetchCalls[0].body.visitorIdPersisted, false, 'setItem自体は例外を投げていないが、読戻しが一致しないためpersisted=falseとして正直に報告するはず');
});
test('R8#5：読戻し不一致（サイレント破損）でvisitorIdPersisted=falseになったイベントは、サーバー側評価でもhashReliable=falseになる（実際のevaluateVisitorIdentityで確認）', async () => {
  const { evaluateVisitorIdentity } = require('../lib/funnelV2');
  const b = browser({ url: 'https://aoki-tosou.net/', brokenLocalStorageWrite: true });
  await tick();
  const sentBody = b.fetchCalls[0].body;
  assert.equal(sentBody.visitorIdPersisted, false);
  const identity = evaluateVisitorIdentity(sentBody.visitorId, sentBody.visitorIdPersisted);
  assert.equal(identity.hashReliable, false, 'persisted=falseで送られたvisitorIdは、visitorId自体の形式が正しくてもhashReliable=falseになる契約（サーバー側の既存ロジック）');
  assert.equal(identity.visitorHash, '');
});
test('R8#5：setItem後の読戻しが要求どおり一致する健全な場合は、引き続きvisitorIdPersisted=trueを送る（過剰検知しないことの確認）', async () => {
  const b = browser({ url: 'https://aoki-tosou.net/' });
  await tick();
  assert.equal(b.fetchCalls[0].body.visitorIdPersisted, true);
});
test('R8#5：localStorageに保存済みの既存visitorIdが形式不正（自形式"vid2_..."と一致しない）だと、そのまま信用せず新しいvisitorIdを再発行する', async () => {
  const localStore = new Map([['aoki_analytics_v2_visitor_id', 'not-a-valid-visitor-id-format']]);
  const b = browser({ url: 'https://aoki-tosou.net/', localStore });
  await tick();
  const sentId = b.fetchCalls[0].body.visitorId;
  assert.notEqual(sentId, 'not-a-valid-visitor-id-format', '形式不正な既存値をそのまま使い回していないこと');
  assert.match(sentId, /^vid2_[a-zA-Z0-9]+$/, '新しく発行されたvisitorIdは正しい自形式であること');
  assert.equal(b.fetchCalls[0].body.visitorIdPersisted, true, '再発行した新しいIDは、正常なstorageへ正しく書込み・読戻し確認できているのでpersisted=trueであるはず');
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

/* ===================================================================
 * 独立監査再提出R8・項目10：401の待機エスカレーション回数（trialCount）とは独立した
 * 総試行回数上限（totalAttempts・STOP_TOTAL_ATTEMPT_LIMIT）。401以外の失敗が続く限り
 * trialCountが進まず、無制限ポーリング・ページ再読込による回数上限の迂回が可能に
 * なっていた欠陥への対応。
 * =================================================================== */
test('R8#10：401以外の失敗（一時的な5xx）だけが続く場合でも、実試行総数が上限（STOP_TOTAL_ATTEMPT_LIMIT）に達したらfinalStoppedになり以後は自動試験しない（trialCountは0のまま）', async () => {
  const b = browser({
    url: 'https://aoki-tosou.net/',
    fetchResponder: (url, init, callIndex) => ({ status: callIndex === 0 ? 401 : 503 })
  });
  await tick();
  assert.equal(b.api.isStopped(), true);
  const limit = b.api._internal.STOP_TOTAL_ATTEMPT_LIMIT;
  assert.ok(limit > 4, '総試行数上限は401専用のtrialCount上限（4）より大きい独立した値のはず');
  for (let i = 0; i < limit; i++) {
    b.advance(15 * 60 * 1000 + 1000); // rescheduleTrialWaitは常に15分固定（エスカレートしない）
    b.api._internal.attemptTrialResend();
    await tick();
  }
  let state = b.api._internal.loadStopState();
  assert.equal(state.trialCount, 0, '401以外の失敗が続いたのでtrialCountは0のまま（401専用カウンタは無関係の失敗で進まない）');
  assert.equal(state.totalAttempts, limit, `ちょうど上限（${limit}）回まで実際に試行しているはず`);
  assert.equal(state.finalStopped, false, '上限ちょうどの回数までは、まだ許容される最後の試行として実行される');

  // 上限を超える（limit+1回目の）試行は、実際にはfetchを試みず、その場でfinalStopped化する。
  const fetchCallsBeforeOverLimit = b.fetchCalls.length;
  b.advance(120 * 60 * 1000);
  b.api._internal.attemptTrialResend();
  await tick();
  state = b.api._internal.loadStopState();
  assert.equal(state.finalStopped, true, '401とは無関係の失敗が続いても、総試行数の上限を超えようとした時点でfinalStoppedになる（無制限リトライの防止）');
  assert.equal(b.fetchCalls.length, fetchCallsBeforeOverLimit, '上限超過時はfetchそのものを試みない（試行済み回数を1つも超えて消費しない）');

  // finalStopped後は、待機時間が経過していても追加の試行が一切発生しない。
  const fetchCallsAfterFinalStopped = b.fetchCalls.length;
  b.advance(120 * 60 * 1000);
  b.api._internal.attemptTrialResend();
  await tick();
  assert.equal(b.fetchCalls.length, fetchCallsAfterFinalStopped, 'finalStopped後はいつ呼んでも追加のfetchが一切発生しない');
});
test('R8#10：totalAttemptsは401か否かに関わらずすべての実試行を数える一方、trialCountは401再発時だけ進む（2つのカウンタの独立性）', async () => {
  const b = browser({
    url: 'https://aoki-tosou.net/',
    // callIndex: 0=初回401（停止開始）。以後の試験再送はcallIndexの偶奇で401/503を交互に返す。
    fetchResponder: (url, init, callIndex) => ({ status: callIndex % 2 === 0 ? 401 : 503 })
  });
  await tick();
  assert.equal(b.api.isStopped(), true);
  for (let i = 0; i < 5; i++) {
    b.advance(120 * 60 * 1000 + 1000); // どのエスカレート段階でも足りる長さ（上限120分）だけ進める
    b.api._internal.attemptTrialResend();
    await tick();
  }
  const state = b.api._internal.loadStopState();
  assert.equal(state.totalAttempts, 5, '401・503のどちらの結果でも、実際に試行した回数はすべてtotalAttemptsへ数えられる');
  assert.ok(state.trialCount > 0 && state.trialCount < state.totalAttempts,
    `trialCount（${state.trialCount}）は401だった回数分だけ進み、503の回では進まないため、必ずtotalAttempts（${state.totalAttempts}）より少ない`);
});
test('R8#10：ページ再読込（同じlocalStorageを引き継ぐ新しいbrowser()インスタンス）を挟んでも、累積の総試行数上限を迂回できない（無制限ポーリング／リロードバイパスの防止）', async () => {
  // 実ブラウザではリロードしても壁時計は止まらない（JSヒープ・クロージャだけが
  // リセットされる）。browser()harnessの各インスタンスは自前のcurrentNowを
  // opts.now起点で個別に持つため、この壁時計の連続性をテスト側で明示的に模擬する
  // （simulatedNowを共有し、advance()のたびに両方へ加算する）。
  const shared = new Map();
  let simulatedNow = RealDate.parse('2026-09-07T00:00:00+09:00');
  let b = browser({
    url: 'https://aoki-tosou.net/', localStore: shared, now: simulatedNow,
    fetchResponder: (url, init, callIndex) => ({ status: callIndex === 0 ? 401 : 503 })
  });
  await tick();
  const limit = b.api._internal.STOP_TOTAL_ATTEMPT_LIMIT;
  const half = Math.floor(limit / 2);
  for (let i = 0; i < half; i++) {
    const step = 15 * 60 * 1000 + 1000;
    b.advance(step); simulatedNow += step;
    b.api._internal.attemptTrialResend();
    await tick();
  }
  let state = b.api._internal.loadStopState();
  assert.equal(state.totalAttempts, half, '前半分の試行がlocalStorageへ記録されている');
  assert.equal(state.finalStopped, false);

  // 「ページ再読込」を、同じlocalStorage（Map）を共有し、壁時計も引き継いだ新しい
  // browser()インスタンスの生成で模擬する。init()が再度走るが、nextTrialAtがまだ
  // 先なので何も起きないはず（即時試験しない＝R6#9訂正の契約を維持したまま）。
  b = browser({ url: 'https://aoki-tosou.net/', localStore: shared, now: simulatedNow, fetchResponder: () => ({ status: 503 }) });
  await tick();
  state = b.api._internal.loadStopState();
  assert.equal(state.totalAttempts, half, 'リロード直後・nextTrialAt未到来の時点ではtotalAttemptsは増えない（即時試験しない）');

  // リロード後の新しいインスタンスでも、残り試行を繰り返せば同じ累積上限へ到達する
  // （state自体はlocalStorage経由で正しく引き継がれている）。
  for (let i = 0; i < limit - half + 1; i++) {
    const step = 15 * 60 * 1000 + 1000;
    b.advance(step); simulatedNow += step;
    b.api._internal.attemptTrialResend();
    await tick();
  }
  state = b.api._internal.loadStopState();
  assert.equal(state.finalStopped, true, 'リロードを挟んでも、累積の総試行数が上限を超えればfinalStoppedになる（リロードによる回数上限の迂回はできない）');
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

/* =====================================================================
 * 独立監査再提出R8・項目4：壊れたsessionStorage状態によるイベント消失の防止。
 * 以前のloadVisitState()は「JSON objectか」しか確認しておらず、visitId欠損・
 * 形式不正な保存状態でもlastActivityAtが新しければそのまま「現在の訪問」として
 * 使い続け、V2 writerが400（恒久4xx）で拒否 → sendViaFetchの契約で永久削除、
 * を繰り返す＝タイムアウト（30分）が来るまでイベントがサイレントに失われ続ける
 * バグだった。isValidVisitState()による厳格検証（R8で新設）が、この種の破損
 * 状態を検知して無効化し、新しいvisitIdを発行することを確認する。
 * ===================================================================== */
const { VISIT_ID_PATTERN } = require('../lib/funnelV2');

/** 対象のsessionStorageキー（"visit状態"用）を、実際に正常動作した1回のbrowser()
 * インスタンスから動的に特定する（キー名をこのテストファイルへハードコードしない＝
 * analytics-v2.js側でキー名が変わっても追従する）。 */
function visitStateSessionKey() {
  const probe = browser({ url: 'https://aoki-tosou.net/', fetchResponder: () => ({ status: 200 }) });
  const keys = Array.from(probe.sessionStore.keys());
  assert.equal(keys.length, 1, 'visit状態のsessionStorageキーは1つだけのはず（想定外のキーが増えている可能性）');
  return keys[0];
}
const VISIT_STATE_SESSION_KEY = visitStateSessionKey();

function assertFreshValidVisitGenerated(fetchCalls, detail) {
  assert.equal(fetchCalls.length, 1, detail);
  const body = fetchCalls[0].body;
  assert.ok(VISIT_ID_PATTERN.test(body.visit_id), `新しく発行されたvisit_idがV2 writerの中核検証（VISIT_ID_PATTERN）を満たすこと。実値=${body.visit_id}`);
  assert.equal(body.schemaVersion, 2);
  assert.ok(typeof body.event_id === 'string' && body.event_id.length > 0);
}

test('R8#4：sessionStorageの保存済みvisit状態が空オブジェクト{}だと、無効化されて新しいvisitIdが発行される', async () => {
  const sessionStore = new Map([[VISIT_STATE_SESSION_KEY, JSON.stringify({})]]);
  const b = browser({ url: 'https://aoki-tosou.net/', sessionStore, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assertFreshValidVisitGenerated(b.fetchCalls, '空オブジェクトの保存状態は無効として扱われ、新しい訪問が1件生成されるはず');
});

test('R8#4：保存済みvisitIdの形式が不正（V2 writerのVISIT_ID_PATTERNを満たさない）だと、その状態は無効化され新しいvisitIdが発行される', async () => {
  const now = RealDate.parse('2026-09-07T00:00:00+09:00');
  const brokenState = {
    visitId: 'not-a-valid-visit-id!!', // VISIT_ID_PATTERN（[A-Za-z0-9_-]{16,100}）を満たさない（!!を含む）
    startedAt: now, lastActivityAt: now, boundaryKey: null,
    mediaCode: '', webSource: 'direct', landingPage: 'https://aoki-tosou.net/'
  };
  const sessionStore = new Map([[VISIT_STATE_SESSION_KEY, JSON.stringify(brokenState)]]);
  const b = browser({ url: 'https://aoki-tosou.net/', sessionStore, now, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assertFreshValidVisitGenerated(b.fetchCalls, '不正な形式のvisitIdを持つ保存状態は無効として扱われるはず');
  assert.notEqual(b.fetchCalls[0].body.visit_id, brokenState.visitId, '壊れたvisitIdをそのまま使い回していないこと');
});

test('R8#4：保存済みlastActivityAtが型不正（数値でない）だと、その状態は無効化され新しいvisitIdが発行される', async () => {
  const now = RealDate.parse('2026-09-07T00:00:00+09:00');
  const brokenState = {
    visitId: 'vst2_looksvalidbutlastactivityatisbroken',
    startedAt: now, lastActivityAt: 'not-a-number', boundaryKey: null, // ここが型不正
    mediaCode: '', webSource: 'direct', landingPage: 'https://aoki-tosou.net/'
  };
  const sessionStore = new Map([[VISIT_STATE_SESSION_KEY, JSON.stringify(brokenState)]]);
  const b = browser({ url: 'https://aoki-tosou.net/', sessionStore, now, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assertFreshValidVisitGenerated(b.fetchCalls, 'lastActivityAtが型不正な保存状態は無効として扱われるはず');
  assert.notEqual(b.fetchCalls[0].body.visit_id, brokenState.visitId);
});

test('R8#4：保存済みvisit状態が破損JSON（パース不能な文字列）だと、無効化されて新しいvisitIdが発行される（従来からのtry/catchで例外は既に吸収されるが、その後null相当として正しく扱われることまで確認）', async () => {
  const sessionStore = new Map([[VISIT_STATE_SESSION_KEY, '{this is not valid json']]);
  const b = browser({ url: 'https://aoki-tosou.net/', sessionStore, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assertFreshValidVisitGenerated(b.fetchCalls, '破損JSONの保存状態は無効として扱われ、新しい訪問が1件生成されるはず');
});

test('R8#4：visitIdが欠損（フィールド自体が無い）保存状態も無効化される', async () => {
  const now = RealDate.parse('2026-09-07T00:00:00+09:00');
  const brokenState = {
    startedAt: now, lastActivityAt: now, boundaryKey: null,
    mediaCode: '', webSource: 'direct', landingPage: 'https://aoki-tosou.net/'
    // visitId自体が無い
  };
  const sessionStore = new Map([[VISIT_STATE_SESSION_KEY, JSON.stringify(brokenState)]]);
  const b = browser({ url: 'https://aoki-tosou.net/', sessionStore, now, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assertFreshValidVisitGenerated(b.fetchCalls, 'visitId欠損の保存状態は無効として扱われるはず');
});

test('R8#4：正常な保存済みvisit状態（有効な形式）は引き続きそのまま再利用される（過剰検知しないことの確認）', async () => {
  const now = RealDate.parse('2026-09-07T00:00:00+09:00');
  const healthyState = {
    visitId: 'vst2_healthystatereusedcorrectly0001',
    startedAt: now - 60000, lastActivityAt: now - 60000, boundaryKey: null,
    mediaCode: 'meishi', webSource: 'direct', landingPage: 'https://aoki-tosou.net/'
  };
  assert.ok(VISIT_ID_PATTERN.test(healthyState.visitId), 'このテスト自体のfixtureが正しいVISIT_ID_PATTERN形式であること（前提条件）');
  const sessionStore = new Map([[VISIT_STATE_SESSION_KEY, JSON.stringify(healthyState)]]);
  const b = browser({ url: 'https://aoki-tosou.net/', sessionStore, now, fetchResponder: () => ({ status: 200 }) });
  await tick();
  assert.equal(b.fetchCalls.length, 1);
  assert.equal(b.fetchCalls[0].body.visit_id, healthyState.visitId, '正常な保存状態は無効化されず、そのまま再利用されるはず（誤検知でイベントを無駄に新規visit化しない）');
});
