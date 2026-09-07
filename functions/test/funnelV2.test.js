'use strict';

/* =====================================================================
 * Web流入媒体識別精度改善・単位EF 検証テスト（2026-09-07・独立監査差し戻し対応版）
 * 合成fixtureのみ使用。実Firestore・実本番プロジェクトへは一切接続しない
 * （fakeFirestoreはfunnel.test.jsの既存パターンをそのまま再利用）。
 * ===================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFunnelStore } = require('../lib/funnel'); // V1実装（契約テストでそのまま実行して比較する）
const {
  validateCoreFields,
  normalizeMediaCode,
  normalizeWebSource,
  evaluateVisitorIdentity,
  isOlderTuple,
  recordWebEventV2,
  jstDateKey,
  isNewMethodLog,
  classifyLogCategory,
  buildQualityAxes,
  computeLeadScoreLevelV2_,
  buildLeadScoreBreakdownV2,
  signVerifyJwt,
  verifyVerifyJwt
} = require('../lib/funnelV2');

// funnel.test.jsのfakeFirestoreをベースに、実Firestoreの制約（transaction内は全readが
// 全writeより先でなければならない）を検知できるよう強化したもの（2026-09-07・Emulator
// READ ONLY確認でrecordWebEventV2の実装バグ〔dailyVisitorRefへのcreateがvisit_sessionsの
// getより先に発生していた〕を発見・修正した際に追加。以後この種の回帰を高速な単体テストでも
// 検知できるようにする）。
function fakeFirestore() {
  const data = new Map();
  function ref(path) {
    return { path, collection(name) { return { doc(id) { return ref(`${path}/${name}/${id}`); } }; } };
  }
  return {
    _data: data,
    collection(name) { return { doc(id) { return ref(`${name}/${id}`); } }; },
    async runTransaction(callback) {
      // writeStartedはtransaction（runTransaction呼び出し）ごとにリセットする
      // （db全体で1回だけにすると、同一dbへの2回目以降のrecordWebEventV2呼び出しが
      // 誤って「write後のread」と判定されてしまう＝2026-09-07に自己発見・修正）。
      let writeStarted = false;
      const transaction = {
        async get(document) {
          if (writeStarted) throw new Error('Firestore transactions require all reads to be executed before all writes. (fakeFirestore再現)');
          return { exists: data.has(document.path), data() { return data.get(document.path); } };
        },
        set(document, value, options) { writeStarted = true; data.set(document.path, options && options.merge ? Object.assign({}, data.get(document.path) || {}, value) : value); },
        create(document, value) { writeStarted = true; if (data.has(document.path)) throw new Error('already exists'); data.set(document.path, value); }
      };
      return callback(transaction);
    }
  };
}
const COLLECTIONS = { interactionLogs: 'interaction_logs', funnelDaily: 'funnel_daily', visitSessions: 'visit_sessions' };

/* ===================================================================
 * validateCoreFields：中核5フィールドのみ400対象、暗黙型変換を許さない（監査差し戻し#7）
 * =================================================================== */
test('schemaVersionが2でなければ拒否', () => {
  const r = validateCoreFields({ schemaVersion: 1, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: Date.now(), eventType: 'page_view' });
  assert.equal(r.ok, false);
});
test('visit_id欠損は拒否（V2 writerはlegacy受理しない）', () => {
  const r = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), occurredAt: Date.now(), eventType: 'page_view' });
  assert.equal(r.ok, false);
  assert.match(r.error, /visit_id/);
});
test('event_id欠損は拒否', () => {
  const r = validateCoreFields({ schemaVersion: 2, visit_id: 'b'.repeat(20), occurredAt: Date.now(), eventType: 'page_view' });
  assert.equal(r.ok, false);
});
test('occurredAtが整数でなければ拒否', () => {
  const r = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: 'not-a-number', eventType: 'page_view' });
  assert.equal(r.ok, false);
});
test('occurredAtが未来5分を超えると拒否', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  const r = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: now.getTime() + 6 * 60 * 1000, eventType: 'page_view' }, now);
  assert.equal(r.ok, false);
});
test('occurredAtが過去24時間を超えると拒否', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  const r = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: now.getTime() - 25 * 60 * 60 * 1000, eventType: 'page_view' }, now);
  assert.equal(r.ok, false);
});
test('eventTypeはphone_click固定（phone_tapは不採用。実コード確認済み）', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  const bad = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: now.getTime(), eventType: 'phone_tap' }, now);
  assert.equal(bad.ok, false);
  const good = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: now.getTime(), eventType: 'phone_click' }, now);
  assert.equal(good.ok, true);
});
test('正常payloadは受理される', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  const r = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: now.getTime(), eventType: 'page_view' }, now);
  assert.equal(r.ok, true);
  assert.equal(r.core.eventId, 'a'.repeat(20));
});
test('event_idが数値型なら文字列へ暗黙変換せず拒否する（監査差し戻し#7）', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  const r = validateCoreFields({ schemaVersion: 2, event_id: 12345678901234, visit_id: 'b'.repeat(20), occurredAt: now.getTime(), eventType: 'page_view' }, now);
  assert.equal(r.ok, false);
  assert.match(r.error, /string/);
});
test('visit_idが数値型なら文字列へ暗黙変換せず拒否する', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  const r = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 1234567890123456, occurredAt: now.getTime(), eventType: 'page_view' }, now);
  assert.equal(r.ok, false);
});
test('occurredAtが数字文字列なら数値へ暗黙変換せず拒否する（監査差し戻し#7）', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  const r = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: String(now.getTime()), eventType: 'page_view' }, now);
  assert.equal(r.ok, false);
  assert.match(r.error, /number/);
});
test('occurredAtがboolean/nullなら拒否する', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  assert.equal(validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: true, eventType: 'page_view' }, now).ok, false);
  assert.equal(validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), visit_id: 'b'.repeat(20), occurredAt: null, eventType: 'page_view' }, now).ok, false);
});

/* ===================================================================
 * normalizeMediaCode：不正でもイベント全体は拒否しない（ソフト縮退）
 * =================================================================== */
test('空のmediaCodeはvalidity=none', () => {
  assert.deepEqual(normalizeMediaCode(''), { mediaCode: '', mediaValidity: 'none' });
});
test('正しい形式のmediaCodeはvalidity=valid', () => {
  const r = normalizeMediaCode('meishi_v1');
  assert.equal(r.mediaValidity, 'valid');
  assert.equal(r.mediaCode, 'meishi_v1');
});
test('許容文字外はvalidity=invalidかつ生値を保持しない（診断ハッシュのみ）', () => {
  const r = normalizeMediaCode('<script>bad');
  assert.equal(r.mediaValidity, 'invalid');
  assert.equal(r.mediaCode, '');
  assert.ok(r.invalidMediaCodeHash && r.invalidMediaCodeHash.length === 16);
});
test('65文字以上はinvalid', () => {
  const r = normalizeMediaCode('x'.repeat(65));
  assert.equal(r.mediaValidity, 'invalid');
});
test('回帰（監査差し戻しR2 #1）：数値のvisitMediaCode（例：123）は暗黙のString化で正常媒体コードへ昇格しない', () => {
  const r = normalizeMediaCode(123);
  assert.equal(r.mediaValidity, 'invalid', '型不正（string以外）は常にinvalidへ縮退させ、たまたま形式に一致しても正常扱いしない');
  assert.equal(r.mediaCode, '');
  assert.ok(r.invalidMediaCodeHash);
});
test('真偽値・オブジェクト等の型不正なvisitMediaCodeもinvalidへ縮退する', () => {
  assert.equal(normalizeMediaCode(true).mediaValidity, 'invalid');
  assert.equal(normalizeMediaCode({ code: 'meishi' }).mediaValidity, 'invalid');
  assert.equal(normalizeMediaCode(['meishi']).mediaValidity, 'invalid');
});
test('null/undefinedのvisitMediaCodeは型不正ではなく欠損としてvalidity=none', () => {
  assert.equal(normalizeMediaCode(null).mediaValidity, 'none');
  assert.equal(normalizeMediaCode(undefined).mediaValidity, 'none');
});

/* ===================================================================
 * normalizeWebSource：監査差し戻し#7（小文字化後にdirect判定・厳格なホスト名検証）
 * =================================================================== */
test('空文字はwebSourceStatus=none（媒体はあるが参照元情報なし、を表す）', () => {
  assert.deepEqual(normalizeWebSource(''), { webSource: '', webSourceStatus: 'none' });
});
test("小文字'direct'はそのまま直接アクセスとして扱う", () => {
  const r = normalizeWebSource('direct');
  assert.equal(r.webSourceStatus, 'direct');
});
test("大文字混じり'Direct'/'DIRECT'も小文字化後にdirect判定される", () => {
  assert.equal(normalizeWebSource('Direct').webSourceStatus, 'direct');
  assert.equal(normalizeWebSource('DIRECT').webSourceStatus, 'direct');
});
test('正常なホスト名はwebSourceStatus=referrer', () => {
  const r = normalizeWebSource('google.com');
  assert.equal(r.webSourceStatus, 'referrer');
  assert.equal(r.webSource, 'google.com');
});
test('大文字ホスト名は小文字化される', () => {
  assert.equal(normalizeWebSource('Google.COM').webSource, 'google.com');
});
test('不正な値はwebSourceStatus=invalidとなり、directへ変換されない', () => {
  const r = normalizeWebSource('not a valid host!!');
  assert.equal(r.webSourceStatus, 'invalid');
  assert.equal(r.webSource, '');
  assert.notEqual(r.webSource, 'direct');
  assert.ok(r.invalidWebSourceHash);
});
test('連続ドットを含むホスト名はinvalid（監査差し戻し#7）', () => {
  assert.equal(normalizeWebSource('google..com').webSourceStatus, 'invalid');
});
test('先頭ドットのホスト名はinvalid', () => {
  assert.equal(normalizeWebSource('.google.com').webSourceStatus, 'invalid');
});
test('末尾ドットのホスト名はinvalid', () => {
  assert.equal(normalizeWebSource('google.com.').webSourceStatus, 'invalid');
});
test('先頭ハイフンのラベルを含むホスト名はinvalid', () => {
  assert.equal(normalizeWebSource('-google.com').webSourceStatus, 'invalid');
});
test('末尾ハイフンのラベルを含むホスト名はinvalid', () => {
  assert.equal(normalizeWebSource('google-.com').webSourceStatus, 'invalid');
});
test('ラベル内部のハイフンは許容される', () => {
  assert.equal(normalizeWebSource('search-engine.example.com').webSourceStatus, 'referrer');
});
test('回帰（監査差し戻しR2 #1）：数値のvisitWebSource（例：123）は暗黙のString化で正常referrerへ昇格しない', () => {
  const r = normalizeWebSource(123);
  assert.equal(r.webSourceStatus, 'invalid', '型不正（string以外）は常にinvalidへ縮退させ、たまたま単一ラベルのホスト名形式に一致しても正常扱いしない');
  assert.equal(r.webSource, '');
  assert.ok(r.invalidWebSourceHash);
});
test('真偽値・オブジェクト等の型不正なvisitWebSourceもinvalidへ縮退する', () => {
  assert.equal(normalizeWebSource(true).webSourceStatus, 'invalid');
  assert.equal(normalizeWebSource({ host: 'google.com' }).webSourceStatus, 'invalid');
});
test('null/undefinedのvisitWebSourceは型不正ではなく欠損としてwebSourceStatus=none', () => {
  assert.equal(normalizeWebSource(null).webSourceStatus, 'none');
  assert.equal(normalizeWebSource(undefined).webSourceStatus, 'none');
});

/* ===================================================================
 * evaluateVisitorIdentity：全組合せ（欠損・型不正規則を含む）
 * =================================================================== */
const VALID_VISITOR_ID = 'v_' + 'a'.repeat(20);
test('visitorIdPersisted=true かつ有効ID のみ hashReliable=true', () => {
  const r = evaluateVisitorIdentity(VALID_VISITOR_ID, true);
  assert.equal(r.hashReliable, true);
  assert.equal(r.visitorIdStatus, 'ok');
  assert.ok(r.visitorHash);
});
test('visitorIdPersisted=true かつ欠損ID は hashReliable=false・イベントは受理想定（例外を投げない）', () => {
  const r = evaluateVisitorIdentity('', true);
  assert.equal(r.hashReliable, false);
  assert.equal(r.visitorHash, '');
});
test('visitorIdPersisted=true かつ不正形式ID は hashReliable=false', () => {
  const r = evaluateVisitorIdentity('short', true);
  assert.equal(r.hashReliable, false);
});
test('visitorIdPersisted=false かつ有効ID でも hashReliable=false（persisted優先）', () => {
  const r = evaluateVisitorIdentity(VALID_VISITOR_ID, false);
  assert.equal(r.hashReliable, false);
  assert.equal(r.visitorHash, '');
});
test('visitorIdPersistedが欠損（undefined）でもイベント処理は継続しhashReliable=false', () => {
  const r = evaluateVisitorIdentity(VALID_VISITOR_ID, undefined);
  assert.equal(r.hashReliable, false);
  assert.equal(r.visitorIdStatus, 'invalid');
});
test('visitorIdPersistedがboolean以外（文字列等）でもhashReliable=false', () => {
  const r = evaluateVisitorIdentity(VALID_VISITOR_ID, 'true');
  assert.equal(r.hashReliable, false);
  assert.equal(r.visitorIdStatus, 'invalid');
});
test('生visitorIdが戻り値のどこにも含まれない', () => {
  const r = evaluateVisitorIdentity(VALID_VISITOR_ID, true);
  assert.equal(JSON.stringify(r).indexOf(VALID_VISITOR_ID), -1);
});
test('回帰（監査差し戻しR2 #1）：数値のvisitorId（例：1234567890123456）は暗黙のString化でhashReliable=trueへ昇格しない', () => {
  // 16桁の数値はString化すると16文字の数字列となり、VISITOR_ID_PATTERNへ偶然一致し得る。
  // visitorIdPersisted:trueと組み合わさると、修正前は誤ってhashReliable=trueになっていた。
  const r = evaluateVisitorIdentity(1234567890123456, true);
  assert.equal(r.hashReliable, false, '型不正（string以外）のvisitorIdは、桁数が偶然パターンに一致してもhashReliable=trueへ昇格させない');
  assert.equal(r.visitorIdStatus, 'invalid');
  assert.equal(r.visitorHash, '');
});
test('真偽値・オブジェクト等の型不正なvisitorIdもhashReliable=falseへ縮退する', () => {
  assert.equal(evaluateVisitorIdentity(true, true).hashReliable, false);
  assert.equal(evaluateVisitorIdentity({ id: VALID_VISITOR_ID }, true).hashReliable, false);
  assert.equal(evaluateVisitorIdentity([VALID_VISITOR_ID], true).hashReliable, false);
});

/* ===================================================================
 * isOlderTuple：(occurredAt, event_id) タプル比較・到着順に依存しない決定性
 * =================================================================== */
test('occurredAtが小さい方が古い', () => {
  assert.equal(isOlderTuple({ occurredAt: 100, eventId: 'z' }, { occurredAt: 200, eventId: 'a' }), true);
});
test('occurredAt同値時はevent_id文字列昇順で判定', () => {
  assert.equal(isOlderTuple({ occurredAt: 100, eventId: 'a' }, { occurredAt: 100, eventId: 'b' }), true);
  assert.equal(isOlderTuple({ occurredAt: 100, eventId: 'b' }, { occurredAt: 100, eventId: 'a' }), false);
});
test('到着順に依存しない決定性（入れ替えても同じ結果）', () => {
  const events = [{ occurredAt: 500, eventId: 'm' }, { occurredAt: 500, eventId: 'a' }, { occurredAt: 300, eventId: 'z' }];
  const pick = (list) => list.reduce((oldest, cur) => (isOlderTuple(cur, oldest) ? cur : oldest));
  assert.deepEqual(pick(events), pick(events.slice().reverse()));
  assert.deepEqual(pick(events), { occurredAt: 300, eventId: 'z' });
});

/* ===================================================================
 * recordWebEventV2：原子的transaction契約
 * =================================================================== */
function makeEvent(overrides) {
  return Object.assign({
    eventId: 'e_' + Math.random().toString(36).slice(2, 20),
    visitId: 'v_' + Math.random().toString(36).slice(2, 20),
    occurredAt: Date.now(),
    eventType: 'page_view',
    mediaCode: '', mediaValidity: 'none',
    webSource: 'direct', webSourceStatus: 'direct',
    visitorHash: '', hashReliable: false, visitorIdStatus: 'ok',
    rawVisitorId: 'v_' + Math.random().toString(36).slice(2, 25),
    contactChannel: '', currentPage: '', landingPage: '', referrerHost: '',
    isTest: false
  }, overrides);
}

test('raw log作成後にfunnel_daily更新を疑似的に失敗させても部分不整合が起きない（例外時は何も残らない）', async () => {
  const db = fakeFirestore();
  const badDb = {
    collection: db.collection.bind(db),
    async runTransaction(cb) {
      const t = { async get() { return { exists: false, data: () => ({}) }; }, set() { throw new Error('simulated funnel_daily failure'); }, create() {} };
      return cb(t);
    }
  };
  await assert.rejects(() => recordWebEventV2(badDb, COLLECTIONS, makeEvent({})));
  assert.equal(db._data.size, 0, '疑似障害時、raw log・daily・visit_sessionのいずれも書き込まれていないこと');
});

test('同一event_idの再送は1件として成功する（重複記録されない）', async () => {
  const db = fakeFirestore();
  const event = makeEvent({ eventId: 'dup-event-id-0001' });
  const r1 = await recordWebEventV2(db, COLLECTIONS, event);
  const r2 = await recordWebEventV2(db, COLLECTIONS, event);
  assert.equal(r1.recorded, true);
  assert.equal(r2.recorded, false);
  assert.equal(r2.duplicate, true);
  const day = jstDateKey(new Date());
  const daily = db._data.get(`funnel_daily/${day}`);
  assert.equal(daily.metrics.pageViews, 1, '再送で二重計上されないこと');
});

test('page_viewよりline_click/phone_clickが先着しても訪問媒体・sourceを失わない', async () => {
  const db = fakeFirestore();
  const visitId = 'v_reaction_first_0001';
  const clickEvent = makeEvent({ eventId: 'e_click_0001', visitId, eventType: 'line_click', occurredAt: 1000, mediaCode: 'meishi_v1', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' });
  await recordWebEventV2(db, COLLECTIONS, clickEvent);
  let session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.mediaCode, 'meishi_v1');
  assert.equal(session.hasPageView, false, 'line_click単体ではhasPageView=falseのまま');

  const pvEvent = makeEvent({ eventId: 'e_pv_0001', visitId, eventType: 'page_view', occurredAt: 1500, mediaCode: 'meishi_v1', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' });
  await recordWebEventV2(db, COLLECTIONS, pvEvent);
  session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.hasPageView, true, '後発page_viewでhasPageView=trueへ昇格すること');
  assert.equal(session.mediaCode, 'meishi_v1', '媒体情報が失われていないこと');
});

test('最小(occurredAt,event_id)が正本。より古いイベント後着時は7項目が一括更新され、帰属が異なればattributionMismatchも立つ（監査差し戻しR2 #2）', async () => {
  // 監査差し戻しR2 #2：M202を先に受信後、より古いM101が同一visit_idで後着し正本が
  // 差し替わるケース。旧実装は正本更新パスでattributionMismatchを一切評価しておらず、
  // 「同一訪問内に矛盾した帰属が実在するのに監査上『矛盾なし』と記録される」バグがあった。
  const db = fakeFirestore();
  const visitId = 'v_attribution_0001';
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_second_0002', visitId, occurredAt: 2000, mediaCode: 'M202', mediaValidity: 'valid', webSource: 'direct', webSourceStatus: 'direct' }));
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_first_0001', visitId, occurredAt: 1000, mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' }));
  const session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.mediaCode, 'M101', 'より古いイベント（M101）が正本として採用されること');
  assert.equal(session.attributionEventId, 'e_first_0001');
  assert.equal(session.attributionMismatch, true, '正本差し替え時でも旧正本(M202)と新正本(M101)の帰属が異なるためattributionMismatch=trueとすること');
});

test('より古いイベント後着時でも、帰属が既存正本と同一なら7項目は更新されてもattributionMismatchは立たない', async () => {
  // 上のテストとの対比：正本の差し替え自体はattributionMismatchの原因ではなく、
  // 「差し替え前後で帰属の値・statusが異なるかどうか」だけが原因であることを示す。
  const db = fakeFirestore();
  const visitId = 'v_attribution_0001b';
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_second_0002', visitId, occurredAt: 2000, mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' }));
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_first_0001', visitId, occurredAt: 1000, mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' }));
  const session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.attributionEventId, 'e_first_0001', '正本イベントIDはより古い方へ更新されること（startedAt等は更新対象）');
  assert.equal(session.attributionMismatch, false, '帰属の値・statusが両イベントで同一なので不一致ではない');
});

test('正本より新しいoccurredAtで異なる帰属が届いた場合はattributionMismatch=trueのみ、正本は不変', async () => {
  const db = fakeFirestore();
  const visitId = 'v_attribution_0002';
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_a_0001', visitId, occurredAt: 1000, mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' }));
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_b_0002', visitId, occurredAt: 2000, mediaCode: 'M202', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' }));
  const session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.mediaCode, 'M101', '正本は上書きされないこと');
  assert.equal(session.attributionMismatch, true);
});

test('mediaCode/webSourceが同じでもmediaValidity/webSourceStatusが異なれば不一致扱いになる（監査差し戻し#8）', async () => {
  const db = fakeFirestore();
  const visitId = 'v_attribution_status_0001';
  // 最初：不正形式（mediaCode=''・invalid）で到着
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_a_0001', visitId, occurredAt: 1000, mediaCode: '', mediaValidity: 'invalid', webSource: '', webSourceStatus: 'none' }));
  // 後発：同じmediaCode=''・webSource=''だが、statusはnone/none（本来「媒体なし」の意味）で到着
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_b_0002', visitId, occurredAt: 2000, mediaCode: '', mediaValidity: 'none', webSource: '', webSourceStatus: 'none' }));
  const session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.attributionMismatch, true, 'mediaCode/webSourceの値が同じでもstatusが異なるため不一致とすること');
});

test('回帰：Firestore emulatorで発見した「read-after-write」違反が単体テストでも検知される', async () => {
  // Emulator READ ONLY確認（2026-09-07）で、recordWebEventV2がtransaction.create
  // （dailyVisitorRef）をtransaction.get（visitSessionRef）より先に実行しており、実Firestore
  // の「全readは全writeより前」という制約に違反していたことが判明した。修正後は、この
  // fakeFirestore（read-after-write違反を検知する強化版）を通しても例外が起きないことを
  // 確認する（回帰防止）。
  const db = fakeFirestore();
  const result = await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventType: 'page_view', mediaCode: 'M1', mediaValidity: 'valid' }));
  assert.equal(result.recorded, true, 'read-after-write順序違反があれば例外で失敗するはず');
});
test('occurredAt同値時のtie-breakerが到着順に依存しない（transaction経由でも一致）', async () => {
  const dbA = fakeFirestore();
  const visitId = 'v_tie_0001';
  await recordWebEventV2(dbA, COLLECTIONS, makeEvent({ eventId: 'bbb', visitId, occurredAt: 1000, mediaCode: 'M1', mediaValidity: 'valid' }));
  await recordWebEventV2(dbA, COLLECTIONS, makeEvent({ eventId: 'aaa', visitId, occurredAt: 1000, mediaCode: 'M2', mediaValidity: 'valid' }));
  const sessionA = dbA._data.get(`visit_sessions/${visitId}`);

  const dbB = fakeFirestore();
  await recordWebEventV2(dbB, COLLECTIONS, makeEvent({ eventId: 'aaa', visitId, occurredAt: 1000, mediaCode: 'M2', mediaValidity: 'valid' }));
  await recordWebEventV2(dbB, COLLECTIONS, makeEvent({ eventId: 'bbb', visitId, occurredAt: 1000, mediaCode: 'M1', mediaValidity: 'valid' }));
  const sessionB = dbB._data.get(`visit_sessions/${visitId}`);

  assert.equal(sessionA.attributionEventId, 'aaa');
  assert.equal(sessionB.attributionEventId, 'aaa');
  assert.equal(sessionA.mediaCode, sessionB.mediaCode, '到着順を入れ替えても最終結果が一致すること');
});

/* ===================================================================
 * funnel_daily V1互換：値そのものをV1実装（createFunnelStore）と直接比較する
 * （監査差し戻し#3：フィールド名だけの一致テストは禁止・値を比較する契約テストを追加）
 * =================================================================== */
test('funnel_dailyの直下フィールド集合がV1と同一（新概念を混ぜない）', async () => {
  const db = fakeFirestore();
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventType: 'page_view' }));
  const day = jstDateKey(new Date());
  const daily = db._data.get(`funnel_daily/${day}`);
  const keys = Object.keys(daily).sort();
  assert.deepEqual(keys, ['date', 'metrics', 'sources', 'testMetrics', 'testSources', 'updatedAt'].sort());
});

test('契約テスト：単一page_view（同一visitor・同一source）でV1とV2のfunnel_daily値が完全一致する', async () => {
  const now = new Date('2026-09-07T02:00:00.000Z');
  const rawVisitorId = 'v_contract_test_0001aaaaaaaaaaaa';
  const sourceLabel = 'meishi';

  // --- V1（実装をそのまま実行） ---
  const dbV1 = fakeFirestore();
  const storeV1 = createFunnelStore(dbV1);
  await storeV1.recordWebEvent({
    eventType: 'page_view', eventId: 'v1_event_0001', visitorId: rawVisitorId,
    counter: 'pageViews', source: sourceLabel, isTest: false
  }, now);

  // --- V2 ---
  const dbV2 = fakeFirestore();
  await recordWebEventV2(dbV2, COLLECTIONS, makeEvent({
    eventId: 'v2_event_0001', eventType: 'page_view', occurredAt: now.getTime(),
    mediaCode: sourceLabel, mediaValidity: 'valid', webSource: '', webSourceStatus: 'none',
    rawVisitorId, isTest: false
  }), now);

  const day = jstDateKey(now);
  const dailyV1 = dbV1._data.get(`funnel_daily/${day}`);
  const dailyV2 = dbV2._data.get(`funnel_daily/${day}`);

  assert.deepEqual(dailyV1.metrics, dailyV2.metrics, 'metricsがV1と完全一致すること');
  assert.deepEqual(dailyV1.testMetrics, dailyV2.testMetrics, 'testMetricsがV1と完全一致すること');
  assert.deepEqual(dailyV1.sources, dailyV2.sources, 'sourcesがV1と完全一致すること（label/visitors/pageViews/lineClicksすべて）');
  assert.deepEqual(dailyV1.testSources, dailyV2.testSources, 'testSourcesがV1と完全一致すること');
});

test('契約テスト：同一visitorの複数page_viewでvisitors計上（V1のdailyVisitorRefユニーク判定）がV2でも一致する', async () => {
  const now = new Date('2026-09-07T02:00:00.000Z');
  const rawVisitorId = 'v_contract_test_0002bbbbbbbbbbbb';
  const sourceLabel = 'area_check_v1';

  const dbV1 = fakeFirestore();
  const storeV1 = createFunnelStore(dbV1);
  await storeV1.recordWebEvent({ eventType: 'page_view', eventId: 'v1_pv_0001', visitorId: rawVisitorId, counter: 'pageViews', source: sourceLabel, isTest: false }, now);
  await storeV1.recordWebEvent({ eventType: 'page_view', eventId: 'v1_pv_0002', visitorId: rawVisitorId, counter: 'pageViews', source: sourceLabel, isTest: false }, now);

  const dbV2 = fakeFirestore();
  await recordWebEventV2(dbV2, COLLECTIONS, makeEvent({ eventId: 'v2_pv_0001', eventType: 'page_view', occurredAt: now.getTime(), mediaCode: sourceLabel, mediaValidity: 'valid', webSource: '', webSourceStatus: 'none', rawVisitorId }), now);
  await recordWebEventV2(dbV2, COLLECTIONS, makeEvent({ eventId: 'v2_pv_0002', eventType: 'page_view', occurredAt: now.getTime() + 1000, mediaCode: sourceLabel, mediaValidity: 'valid', webSource: '', webSourceStatus: 'none', rawVisitorId }), now);

  const day = jstDateKey(now);
  const dailyV1 = dbV1._data.get(`funnel_daily/${day}`);
  const dailyV2 = dbV2._data.get(`funnel_daily/${day}`);

  assert.equal(dailyV1.metrics.visitors, 1, '前提：同一visitorの2回目page_viewはV1でもvisitorsを追加加算しない');
  assert.equal(dailyV2.metrics.visitors, dailyV1.metrics.visitors, 'V2のvisitors計上がV1と一致すること');
  assert.equal(dailyV2.metrics.pageViews, dailyV1.metrics.pageViews, 'pageViewsは2件ともカウントされ一致すること');
  assert.deepEqual(dailyV1.sources, dailyV2.sources, 'sources内のvisitors/pageViews内訳もV1と一致すること');
});

test('契約テスト：line_click/phone_clickのsources内訳（phoneClicksが記録されないV1既知仕様）がV2でも一致する', async () => {
  const now = new Date('2026-09-07T02:00:00.000Z');
  const rawVisitorId = 'v_contract_test_0003cccccccccccc';
  const sourceLabel = 'meishi';

  const dbV1 = fakeFirestore();
  const storeV1 = createFunnelStore(dbV1);
  await storeV1.recordWebEvent({ eventType: 'line_click', eventId: 'v1_lc_0001', visitorId: rawVisitorId, counter: 'lineClicks', source: sourceLabel, isTest: false }, now);
  await storeV1.recordWebEvent({ eventType: 'phone_click', eventId: 'v1_pc_0001', visitorId: rawVisitorId, counter: 'phoneClicks', source: sourceLabel, isTest: false }, now);

  const dbV2 = fakeFirestore();
  await recordWebEventV2(dbV2, COLLECTIONS, makeEvent({ eventId: 'v2_lc_0001', eventType: 'line_click', occurredAt: now.getTime(), mediaCode: sourceLabel, mediaValidity: 'valid', webSource: '', webSourceStatus: 'none', rawVisitorId }), now);
  await recordWebEventV2(dbV2, COLLECTIONS, makeEvent({ eventId: 'v2_pc_0001', eventType: 'phone_click', occurredAt: now.getTime() + 1000, mediaCode: sourceLabel, mediaValidity: 'valid', webSource: '', webSourceStatus: 'none', rawVisitorId }), now);

  const day = jstDateKey(now);
  const dailyV1 = dbV1._data.get(`funnel_daily/${day}`);
  const dailyV2 = dbV2._data.get(`funnel_daily/${day}`);

  assert.equal(dailyV1.metrics.lineClicks, 1);
  assert.equal(dailyV1.metrics.phoneClicks, 1);
  assert.deepEqual(dailyV1.metrics, dailyV2.metrics, 'metricsがV1と完全一致すること（lineClicks/phoneClicksとも）');
  assert.deepEqual(dailyV1.sources, dailyV2.sources, 'sources内訳もV1と完全一致すること（phoneClicksがsources側に記録されないV1既知仕様を含む）');
});

test('契約テスト：isTest=trueでtestMetrics/testSourcesがV1と一致する', async () => {
  const now = new Date('2026-09-07T02:00:00.000Z');
  const rawVisitorId = 'v_contract_test_0004dddddddddddd';
  const sourceLabel = 'meishi';

  const dbV1 = fakeFirestore();
  const storeV1 = createFunnelStore(dbV1);
  await storeV1.recordWebEvent({ eventType: 'page_view', eventId: 'v1_pv_test_0001', visitorId: rawVisitorId, counter: 'pageViews', source: sourceLabel, isTest: true }, now);

  const dbV2 = fakeFirestore();
  await recordWebEventV2(dbV2, COLLECTIONS, makeEvent({ eventId: 'v2_pv_test_0001', eventType: 'page_view', occurredAt: now.getTime(), mediaCode: sourceLabel, mediaValidity: 'valid', webSource: '', webSourceStatus: 'none', rawVisitorId, isTest: true }), now);

  const day = jstDateKey(now);
  const dailyV1 = dbV1._data.get(`funnel_daily/${day}`);
  const dailyV2 = dbV2._data.get(`funnel_daily/${day}`);
  assert.deepEqual(dailyV1.testMetrics, dailyV2.testMetrics);
  assert.deepEqual(dailyV1.testSources, dailyV2.testSources);
});

/* ===================================================================
 * hash_reliable：writer/reader往復テスト（監査差し戻し#4。手作りfixtureだけでPASSさせない）
 * =================================================================== */
test('classifyLogCategory: 手作りcamelCase hashReliableだけでは判定しない（round-tripしないと通らないことの確認）', () => {
  // writerが実際に保存するsnake_caseフィールドが無いオブジェクトを渡すと、
  // reliable判定は常にfalse（new_unreliable）になることを確認する。
  const handcrafted = { visit_id: 'v_' + 'a'.repeat(20), visitor_hash: 'x', hashReliable: true /* camelCase：writerは書かない */ };
  assert.equal(classifyLogCategory(handcrafted), 'new_unreliable', 'camelCase hashReliableだけではreliableと判定されないこと');
});
test('往復テスト：recordWebEventV2が保存したraw logをそのままclassifyLogCategoryへ渡すとnew_reliableになる', async () => {
  const db = fakeFirestore();
  const validVisitorId = 'v_' + 'a'.repeat(25);
  const identity = evaluateVisitorIdentity(validVisitorId, true);
  assert.equal(identity.hashReliable, true, '前提：有効visitorId+persisted=trueならhashReliable=true');

  const event = makeEvent({
    eventId: 'e_roundtrip_0001', visitId: 'v_roundtrip_0001'.padEnd(20, '0'),
    visitorHash: identity.visitorHash, hashReliable: identity.hashReliable, visitorIdStatus: identity.visitorIdStatus,
    rawVisitorId: validVisitorId
  });
  await recordWebEventV2(db, COLLECTIONS, event);
  const savedRawLog = db._data.get(`interaction_logs/${event.eventId}`);
  assert.ok(savedRawLog, '前提：raw logが保存されていること');
  assert.equal(savedRawLog.hash_reliable, true, '前提：保存されたraw logにhash_reliable(snake_case)=trueがあること');

  const category = classifyLogCategory(savedRawLog); // ← 保存された実ドキュメントをそのまま渡す
  assert.equal(category, 'new_reliable', '往復（write→read→classify）した結果がnew_reliableになること');
});
test('往復テスト：hashReliable=falseで記録した場合、保存されたraw logはnew_unreliableに分類される', async () => {
  const db = fakeFirestore();
  const identity = evaluateVisitorIdentity('', true); // 欠損ID → hashReliable=false
  const event = makeEvent({ eventId: 'e_roundtrip_0002', visitId: 'v_roundtrip_0002'.padEnd(20, '0'), visitorHash: identity.visitorHash, hashReliable: identity.hashReliable, visitorIdStatus: identity.visitorIdStatus, rawVisitorId: '' });
  await recordWebEventV2(db, COLLECTIONS, event);
  const savedRawLog = db._data.get(`interaction_logs/${event.eventId}`);
  assert.equal(savedRawLog.hash_reliable, false);
  assert.equal(classifyLogCategory(savedRawLog), 'new_unreliable');
});
test('legacy（visit_idなし）＋非空hash → legacy_unknown（信頼できる、ではない）', () => {
  assert.equal(classifyLogCategory({ visit_id: '', visitor_hash: 'abc123' }), 'legacy_unknown');
});
test('legacy（visit_idなし）＋hash空 → legacy_hash_missing', () => {
  assert.equal(classifyLogCategory({ visit_id: '', visitor_hash: '' }), 'legacy_hash_missing');
});
test('カットオーバー後に届いたvisit_idなしログも日付に関わらずlegacy扱いになる', () => {
  assert.equal(classifyLogCategory({ visit_id: '', visitor_hash: 'x', occurredAt: Date.now() + 999999 }), 'legacy_unknown');
});
test('回帰（監査差し戻しR2 #1）：数値のvisit_id（型不正）は暗黙のString化で新方式ログへ昇格しない', () => {
  // isNewMethodLogがString(visitIdRaw||'')で暗黙変換していた場合、桁数次第で
  // VISIT_ID_PATTERNへ偶然一致し「新方式ログ」へ誤分類され得た。
  const numericVisitId = 12345678901234567890; // 20桁の数値
  assert.equal(isNewMethodLog(numericVisitId), false, '型不正なvisit_idは新方式ログと判定しない（legacy扱いへ倒す）');
  assert.equal(classifyLogCategory({ visit_id: numericVisitId, visitor_hash: 'x' }), 'legacy_unknown');
});
test("回帰（監査差し戻しR2 #1）：hash_reliableが真偽値のtrueそのものでない（例：文字列'true'）場合はnew_reliableと判定しない", () => {
  const row = { visit_id: 'v_' + 'a'.repeat(20), visitor_hash: 'x', hash_reliable: 'true' /* truthyだが真偽値ではない */ };
  assert.equal(classifyLogCategory(row), 'new_unreliable', 'hash_reliableは=== trueで厳密一致確認すること（truthyな別型を信頼しない）');
});
test('visitor_hashが文字列型でない（例：数値・真偽値）場合はhashPresentとして扱わない', () => {
  assert.equal(classifyLogCategory({ visit_id: '', visitor_hash: 12345 }), 'legacy_hash_missing');
  assert.equal(classifyLogCategory({ visit_id: '', visitor_hash: true }), 'legacy_hash_missing');
});
test('回帰（監査差し戻しR3）：有効なvisit_id＋hash_reliable=true＋visitor_hash=\'\'（空文字）はnew_unreliable', () => {
  // 監査差し戻しR3：hashPresentを計算していながらnew_reliable判定に使っていなかったため、
  // hash_reliable=trueでもvisitor_hashが空文字ならnew_reliableへ誤分類され得た。
  const row = { visit_id: 'v_' + 'a'.repeat(20), visitor_hash: '', hash_reliable: true };
  assert.equal(classifyLogCategory(row), 'new_unreliable', 'visitor_hashが空文字（非空でない）場合はhash_reliable=trueでもnew_reliableとしない');
});
test('回帰（監査差し戻しR3）：有効なvisit_id＋hash_reliable=true＋visitor_hashが数値等の非文字列でもnew_unreliable', () => {
  const rowNumber = { visit_id: 'v_' + 'a'.repeat(20), visitor_hash: 12345, hash_reliable: true };
  assert.equal(classifyLogCategory(rowNumber), 'new_unreliable', 'visitor_hashが数値（文字列型でない）場合はhash_reliable=trueでもnew_reliableとしない');
  const rowNull = { visit_id: 'v_' + 'a'.repeat(20), visitor_hash: null, hash_reliable: true };
  assert.equal(classifyLogCategory(rowNull), 'new_unreliable', 'visitor_hashがnull（文字列型でない）場合も同様');
});
test('回帰（監査差し戻しR3）：有効なvisit_id＋hash_reliable=true＋非空文字列visitor_hashはnew_reliableのまま（正常系回帰）', () => {
  const row = { visit_id: 'v_' + 'a'.repeat(20), visitor_hash: 'abcdef1234', hash_reliable: true };
  assert.equal(classifyLogCategory(row), 'new_reliable', '正常な組合せ（hash_reliable=true かつ visitor_hashが非空文字列）は引き続きnew_reliableであること');
});

/* ===================================================================
 * buildQualityAxes：hasPageView===trueのみ計上、Web軸キーの統一（監査差し戻し#5）
 * =================================================================== */
test('hasPageView=trueのsessionだけがvisitsへ計上される', () => {
  const sessions = [
    { hasPageView: true, mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' },
    { hasPageView: false, mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' } // reaction-only
  ];
  const { mediaQuality } = buildQualityAxes(sessions);
  assert.equal(mediaQuality[0].visits, 1, 'hasPageView=falseのreaction-only sessionは計上されないこと');
});
test('Web軸キーがsource:referrer:<hostname>形式で統一される', () => {
  const { webSourceQuality } = buildQualityAxes([{ hasPageView: true, mediaCode: '', mediaValidity: 'none', webSource: 'google.com', webSourceStatus: 'referrer' }]);
  assert.equal(webSourceQuality[0].key, 'source:referrer:google.com');
});
test('Web軸キーがsource:direct形式で統一される', () => {
  const { webSourceQuality } = buildQualityAxes([{ hasPageView: true, mediaCode: '', mediaValidity: 'none', webSource: 'direct', webSourceStatus: 'direct' }]);
  assert.equal(webSourceQuality[0].key, 'source:direct');
});
test('Web軸キーがsource:none形式で統一される（媒体あり・参照元なし）', () => {
  const { webSourceQuality } = buildQualityAxes([{ hasPageView: true, mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' }]);
  assert.equal(webSourceQuality[0].key, 'source:none');
});
test('Web軸キーがsource:invalid形式で統一される', () => {
  const { webSourceQuality } = buildQualityAxes([{ hasPageView: true, mediaCode: '', mediaValidity: 'none', webSource: '', webSourceStatus: 'invalid' }]);
  assert.equal(webSourceQuality[0].key, 'source:invalid');
});
test('媒体とWeb参照元の両方の信号を持つvisitは両軸へ独立して計上される', () => {
  const sessions = [{ hasPageView: true, mediaCode: 'M101', mediaValidity: 'valid', webSource: 'google.com', webSourceStatus: 'referrer' }];
  const { mediaQuality, webSourceQuality } = buildQualityAxes(sessions);
  assert.equal(mediaQuality.length, 1);
  assert.equal(webSourceQuality.length, 1);
});
test('invalid媒体でも有効webSourceがあればWeb軸へ独立計上される', () => {
  const sessions = [{ hasPageView: true, mediaCode: '', mediaValidity: 'invalid', webSource: 'yahoo.co.jp', webSourceStatus: 'referrer' }];
  const { mediaQuality, webSourceQuality } = buildQualityAxes(sessions);
  assert.equal(mediaQuality.length, 1);
  assert.equal(mediaQuality[0].key, 'invalid');
  assert.equal(webSourceQuality.length, 1);
  assert.equal(webSourceQuality[0].key, 'source:referrer:yahoo.co.jp');
});

/* ===================================================================
 * VERIFY JWT：署名・iss・aud・scope・期限・本番流用拒否（監査差し戻し#6）
 * =================================================================== */
const SECRET = 'test-secret-please-not-real-0123456789abcdef';
test('正しく署名・発行されたJWTは検証を通る', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, true);
});
test('署名が不正なら拒否され、jtiを一切返さない（監査差し戻し#6）', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const tampered = token.slice(0, -2) + 'xx';
  const r = verifyVerifyJwt(tampered, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature');
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'jti'), false, '署名不正時はjtiを含む戻り値であってはならない');
});
test('別のSecretで署名されたJWTは拒否され、jtiを返さない（本番Secretでの流用拒否を模擬）', () => {
  const { token } = signVerifyJwt('a-different-secret-0123456789abcdefzz', { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature');
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'jti'), false);
});
test('issが一致しないJWTは拒否される（監査差し戻し#6：issテスト追加）', () => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'someone-elses-issuer', sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify', iat: now, exp: now + 900, jti: 'x'.repeat(32) };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = b64(header) + '.' + b64(payload);
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', SECRET).update(signingInput).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = signingInput + '.' + sig;
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'iss');
});
test('audが一致しないJWTは拒否される（他目的への流用拒否）', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'someOtherFunction', scope: 'write:interaction_logs_v2_verify' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'aud');
});
test('scopeが一致しないJWTは拒否される', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'read:something' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'scope');
});
test('subが一致しないJWTは拒否される', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'someone-else@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sub');
});
test('期限切れJWTは拒否される', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify', ttlSeconds: -10 });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exp');
});
test('回帰（監査差し戻しR2 #3）：exp===now（境界値ちょうど）も期限切れとして拒否される（exp<=nowの検証、exp<nowだけでは境界値を見逃す）', () => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'aoki-tosou-funnel-verify-issuer', sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify', iat: now - 1, exp: now, jti: 'x'.repeat(32) };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = b64(header) + '.' + b64(payload);
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', SECRET).update(signingInput).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = signingInput + '.' + sig;
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exp');
});
test('既定有効期限は15分', () => {
  const { exp } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const now = Math.floor(Date.now() / 1000);
  assert.ok(exp - now <= 15 * 60 && exp - now > 15 * 60 - 5);
});
test('JWT本体（token文字列）がverify結果オブジェクトへ含まれない（jtiのみ）', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.ok(r.jti);
  assert.equal(JSON.stringify(r).indexOf(token), -1);
});
test('回帰（監査差し戻しR2 #3）：expectedSubを渡し忘れるとfail-closedで拒否される（sub検証が無効化されない）', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const r1 = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify' });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'missing_expected_sub');
  const r2 = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: '' });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'missing_expected_sub');
  const r3 = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 123 });
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'missing_expected_sub');
});

/* ===================================================================
 * visit_sessions: hashReliable/pageViewCount/reactionCountの追跡（単位D準備・2026-09-07）
 * =================================================================== */
test('visit_sessions作成時：page_viewはpageViewCount=1・reactionCount=0で始まる', async () => {
  const db = fakeFirestore();
  const visitId = 'v_counts_0001';
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_counts_pv', visitId, eventType: 'page_view', hashReliable: true }));
  const session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.pageViewCount, 1);
  assert.equal(session.reactionCount, 0);
  assert.equal(session.hashReliable, true);
});
test('visit_sessions更新時：page_view/line_click/phone_clickがそれぞれ正しいcounterへ加算される', async () => {
  const db = fakeFirestore();
  const visitId = 'v_counts_0002';
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_counts_pv1', visitId, eventType: 'page_view', occurredAt: 1000 }));
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_counts_pv2', visitId, eventType: 'page_view', occurredAt: 2000 }));
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_counts_line', visitId, eventType: 'line_click', occurredAt: 3000 }));
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_counts_phone', visitId, eventType: 'phone_click', occurredAt: 4000 }));
  const session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.pageViewCount, 2, 'page_viewが2件');
  assert.equal(session.reactionCount, 2, 'line_click+phone_clickで2件');
});
test('hashReliableは帰属正本の更新契機（より古いイベント後着）と同じタイミングで更新される', async () => {
  const db = fakeFirestore();
  const visitId = 'v_counts_0003';
  // 先着（新しいoccurredAt）：hashReliable=false
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_counts_new', visitId, occurredAt: 2000, hashReliable: false }));
  let session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.hashReliable, false);
  // 後着（より古いoccurredAt・正本を差し替える）：hashReliable=true
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_counts_old', visitId, occurredAt: 1000, hashReliable: true }));
  session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.hashReliable, true, '正本が差し替わったのでhashReliableも新しい正本の値へ更新される');
});
test('hashReliableは、より新しいイベントが後着（正本を差し替えない）場合は変化しない', async () => {
  const db = fakeFirestore();
  const visitId = 'v_counts_0004';
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_counts_old2', visitId, occurredAt: 1000, hashReliable: true }));
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_counts_new2', visitId, occurredAt: 2000, hashReliable: false }));
  const session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.hashReliable, true, '正本（より古いイベント）はそのままなのでhashReliableも変化しない');
});

/* ===================================================================
 * computeLeadScoreLevelV2_ / buildLeadScoreBreakdownV2（単位D・2026-09-07）
 * =================================================================== */
test('computeLeadScoreLevelV2_: page_viewが無いsessionは判定不能', () => {
  assert.equal(computeLeadScoreLevelV2_({ hasPageView: false, pageViewCount: 0, reactionCount: 0 }), '判定不能');
});
test('computeLeadScoreLevelV2_: 反応（LINE/電話）が1件以上あれば高', () => {
  assert.equal(computeLeadScoreLevelV2_({ hasPageView: true, pageViewCount: 1, reactionCount: 1 }), '高');
});
test('computeLeadScoreLevelV2_: 反応なし・page_view3件以上は中', () => {
  assert.equal(computeLeadScoreLevelV2_({ hasPageView: true, pageViewCount: 3, reactionCount: 0 }), '中');
});
test('computeLeadScoreLevelV2_: 反応なし・page_view1〜2件は低', () => {
  assert.equal(computeLeadScoreLevelV2_({ hasPageView: true, pageViewCount: 1, reactionCount: 0 }), '低');
  assert.equal(computeLeadScoreLevelV2_({ hasPageView: true, pageViewCount: 2, reactionCount: 0 }), '低');
});
test('buildLeadScoreBreakdownV2: hashReliable=falseのsessionは行動によらず判定不能へ集計され、cardsには含まれない（監査正本仕様：unreliable/hash欠損は判定不能）', () => {
  const sessions = [
    { visitId: 'v1', hashReliable: false, hasPageView: true, pageViewCount: 5, reactionCount: 3 } // 行動だけ見れば「高」相当だが不採用
  ];
  const { counts, cards } = buildLeadScoreBreakdownV2(sessions, 0);
  assert.equal(counts.判定不能, 1);
  assert.equal(counts.高, 0);
  assert.equal(cards.length, 0, 'hashReliable=falseはcards（個別カード）に含めない');
});
test('buildLeadScoreBreakdownV2: hashReliable=trueのsessionのみcardsに含まれ、levelが正しく計算される', () => {
  const sessions = [
    { visitId: 'v_high', hashReliable: true, hasPageView: true, pageViewCount: 1, reactionCount: 1, mediaCode: 'M1', mediaValidity: 'valid', webSource: 'direct', webSourceStatus: 'direct', startedAt: 1000 },
    { visitId: 'v_mid', hashReliable: true, hasPageView: true, pageViewCount: 4, reactionCount: 0, mediaCode: '', mediaValidity: 'none', webSource: 'direct', webSourceStatus: 'direct', startedAt: 2000 },
    { visitId: 'v_low', hashReliable: true, hasPageView: true, pageViewCount: 1, reactionCount: 0, mediaCode: '', mediaValidity: 'none', webSource: '', webSourceStatus: 'none', startedAt: 3000 }
  ];
  const { counts, cards } = buildLeadScoreBreakdownV2(sessions, 0);
  assert.equal(counts.高, 1);
  assert.equal(counts.中, 1);
  assert.equal(counts.低, 1);
  assert.equal(counts.判定不能, 0);
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => c.visitId).sort(), ['v_high', 'v_low', 'v_mid']);
  const highCard = cards.find((c) => c.visitId === 'v_high');
  assert.equal(highCard.level, '高');
  assert.equal(highCard.mediaCode, 'M1');
});
test('buildLeadScoreBreakdownV2: 旧ログ件数は呼び出し側から渡された値をそのまま反映する（visit単位ではなくraw log単位）', () => {
  const { counts } = buildLeadScoreBreakdownV2([], 7);
  assert.equal(counts.旧ログ, 7);
});
test('buildLeadScoreBreakdownV2: mediaValidity=invalidのcardはmediaCodeを生値のまま返さない（buildQualityAxesと同じ扱い）', () => {
  const sessions = [
    { visitId: 'v_invalid', hashReliable: true, hasPageView: true, pageViewCount: 1, reactionCount: 0, mediaCode: 'bad code', mediaValidity: 'invalid', webSource: '', webSourceStatus: 'invalid', startedAt: 1000 }
  ];
  const { cards } = buildLeadScoreBreakdownV2(sessions, 0);
  assert.equal(cards[0].mediaCode, '', 'invalidなmediaCodeはcardへ生値のまま出さない');
});
