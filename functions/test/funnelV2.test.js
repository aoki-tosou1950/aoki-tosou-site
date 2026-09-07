'use strict';

/* =====================================================================
 * Web流入媒体識別精度改善・単位EF 検証テスト（2026-09-07・独立監査差し戻し対応版）
 * 合成fixtureのみ使用。実Firestore・実本番プロジェクトへは一切接続しない
 * （fakeFirestoreはfunnel.test.jsの既存パターンをそのまま再利用）。
 * ===================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFunnelStore, computeLeadScore_, pageCategoryOf_, pageKeyOf_ } = require('../lib/funnel'); // V1実装（契約テストでそのまま実行して比較する）
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
  buildLeadScoreBreakdownV2,
  computeSessionLeadScoreV1Compat_,
  buildLegacyPseudoSessions_,
  deriveLegacyMediaAndSource_,
  recoverLegacySourceLabel_,
  extractHostnameFromReferrer_,
  signVerifyJwt,
  verifyVerifyJwt,
  VERIFY_JWT_ISSUER
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

/* ===================================================================
 * 独立監査再提出R8・項目10：visitorIdStatus='inconsistent'（persisted=trueなのに
 * visitorId自体が欠損・不正、というクライアントの主張と実際の値の矛盾）。
 * 単純な型・形式不正（persisted自体が欠損/型不正、またはpersisted=falseで
 * visitorIdも不正）を表す'invalid'とは区別する。どちらもhashReliable=false・
 * visitor_hash=''・イベント受理は維持されることも合わせて確認する。
 * =================================================================== */
test('R8#10：persisted=trueなのにvisitorIdが欠損（空文字）→visitorIdStatus="inconsistent"（"invalid"ではない）', () => {
  const r = evaluateVisitorIdentity('', true);
  assert.equal(r.visitorIdStatus, 'inconsistent');
  assert.equal(r.hashReliable, false);
  assert.equal(r.visitorHash, '');
});
test('R8#10：persisted=trueなのにvisitorIdが不正形式（短すぎる）→visitorIdStatus="inconsistent"', () => {
  const r = evaluateVisitorIdentity('short', true);
  assert.equal(r.visitorIdStatus, 'inconsistent');
  assert.equal(r.hashReliable, false);
  assert.equal(r.visitorHash, '');
});
test('R8#10：persisted=falseでvisitorIdが不正形式（または欠損）は、単純な"invalid"のまま（"inconsistent"にはならない。クライアントは元々persistedできなかったと正直に申告しているだけで矛盾ではない）', () => {
  const r1 = evaluateVisitorIdentity('short', false);
  assert.equal(r1.visitorIdStatus, 'invalid');
  const r2 = evaluateVisitorIdentity('', false);
  assert.equal(r2.visitorIdStatus, 'invalid');
});
test('R8#10：persisted自体が欠損/型不正（visitorIdの正当性に関わらず）は、引き続き"invalid"のまま（"inconsistent"の対象外。persistedの主張自体が無いため矛盾のしようがない）', () => {
  const r1 = evaluateVisitorIdentity(VALID_VISITOR_ID, undefined);
  assert.equal(r1.visitorIdStatus, 'invalid');
  const r2 = evaluateVisitorIdentity(VALID_VISITOR_ID, 'true');
  assert.equal(r2.visitorIdStatus, 'invalid');
});
test('R8#10：persisted=trueかつvisitorIdが有効な場合は引き続き"ok"のまま（"inconsistent"の誤検知が無いことの回帰確認）', () => {
  const r = evaluateVisitorIdentity(VALID_VISITOR_ID, true);
  assert.equal(r.visitorIdStatus, 'ok');
  assert.equal(r.hashReliable, true);
});
test('R8#10：型不正（数値・真偽値・オブジェクト・配列）のvisitorIdでpersisted=trueの場合も"inconsistent"になる（型不正＝欠損・不正の一種として扱う）', () => {
  assert.equal(evaluateVisitorIdentity(1234567890123456, true).visitorIdStatus, 'inconsistent');
  assert.equal(evaluateVisitorIdentity(true, true).visitorIdStatus, 'inconsistent');
  assert.equal(evaluateVisitorIdentity({ id: VALID_VISITOR_ID }, true).visitorIdStatus, 'inconsistent');
  assert.equal(evaluateVisitorIdentity([VALID_VISITOR_ID], true).visitorIdStatus, 'inconsistent');
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
  // 訂正（独立監査再提出R8・項目10）：以前はここで'invalid'を期待していたが、
  // persisted=true（クライアントが「永続化できた」と主張している）にもかかわらず
  // visitorId自体が型不正（欠損・不正の一種）であるこの組合せは、単純な形式不正
  // （'invalid'）ではなく、クライアントの主張と実際の値が矛盾する'inconsistent'へ
  // 分類するのが正しい（R8で新設された区分。「型不正だからinvalidのまま」という
  // 以前の期待値は、区分自体が存在しなかった時点のものであり、これは弱体化ではなく
  // 新しい区分への追従）。
  assert.equal(r.visitorIdStatus, 'inconsistent');
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
  // 訂正（独立監査再提出R8・項目9）：ttlSeconds=-10で発行するとexp<iatになる。
  // R8で追加した「exp > iat」検証（reason='exp_before_iat'）の方がこのケースの実態
  // （期限切れというより、そもそも発行時点で既にexp<iatという不整合なトークン）を
  // より正確に言い当てるため、この新しく細分化された理由コードへ検証を訂正する
  // （汎用的な'exp'のままでは「期限が過ぎた」のか「そもそも順序が壊れていた」のか
  // 区別できなかった）。
  assert.equal(r.reason, 'exp_before_iat');
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
 * 独立監査再提出R8・項目9：VERIFY JWTクレーム検証（iat・jti・15分TTL上限）。
 * 署名後もiat・jti・15分TTL上限を検証していなかった（expが期限切れでないことだけを
 * 見ていた）という指摘への対応。signVerifyJwt()は任意のiat/jti/exp組合せを直接
 * 生成できない（常にiat=now・exp=now+ttlSeconds・jti=ランダムを発行する）ため、
 * 意図的に壊れたクレームを持つトークンは、正しいSECRETで手動署名して構築する
 * （既存テスト「issが一致しない」「exp===now」と同じ手法）。
 * =================================================================== */
const VERIFY_JWT_CRYPTO = require('crypto');
function b64VerifyTest_(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
/** 任意のpayloadをSECRETで正しく署名したJWT文字列を組み立てる（テスト専用。
 * signVerifyJwt()自体は使わない＝iat/jti/expを個別に自由指定するため）。 */
function signRawVerifyTestToken_(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = b64VerifyTest_(header) + '.' + b64VerifyTest_(payload);
  const sig = VERIFY_JWT_CRYPTO.createHmac('sha256', SECRET).update(signingInput).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return signingInput + '.' + sig;
}
const VERIFY_TEST_VERIFY_OPTS = { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' };
function validVerifyPayload_(overrides) {
  const now = Math.floor(Date.now() / 1000);
  return Object.assign({
    iss: VERIFY_JWT_ISSUER, sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify',
    iat: now, exp: now + 900, jti: VERIFY_JWT_CRYPTO.randomBytes(16).toString('hex')
  }, overrides || {});
}

test('R8#9：前提確認：validVerifyPayload_（訂正無し）はverifyVerifyJwtを通る（負テストの基準点）', () => {
  const token = signRawVerifyTestToken_(validVerifyPayload_());
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, true, JSON.stringify(r));
});
test('R8#9：iatが欠損しているJWTは拒否される', () => {
  const payload = validVerifyPayload_();
  delete payload.iat;
  const token = signRawVerifyTestToken_(payload);
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'iat');
});
test('R8#9：iatが型不正（文字列）のJWTは拒否される', () => {
  const token = signRawVerifyTestToken_(validVerifyPayload_({ iat: 'not-a-number' }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'iat');
});
test('R8#9：iatが整数でない（小数）JWTは拒否される', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRawVerifyTestToken_(validVerifyPayload_({ iat: now + 0.5 }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'iat');
});
test('R8#9：expが欠損しているJWTは拒否される', () => {
  const payload = validVerifyPayload_();
  delete payload.exp;
  const token = signRawVerifyTestToken_(payload);
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exp');
});
test('R8#9：expが型不正（文字列）のJWTは拒否される', () => {
  const token = signRawVerifyTestToken_(validVerifyPayload_({ exp: '9999999999' }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exp');
});
test('R8#9：未来すぎるiat（クロックスキュー許容を超える）のJWTは拒否される', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRawVerifyTestToken_(validVerifyPayload_({ iat: now + 3600, exp: now + 3600 + 900 }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'iat_future');
});
test('R8#9：クロックスキュー許容の範囲内（数秒程度の未来iat）は拒否されない', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRawVerifyTestToken_(validVerifyPayload_({ iat: now + 5, exp: now + 5 + 900 }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, true, JSON.stringify(r));
});
test('R8#9：exp <= iat（順序が逆転・同一）のJWTは拒否される', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRawVerifyTestToken_(validVerifyPayload_({ iat: now, exp: now - 100 }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exp_before_iat');
});
test('R8#9：発行有効期間（exp-iat）が確定値15分を超えるJWTは拒否される（発行側の実装ミス・誤指定を検証側で独立に防ぐ）', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRawVerifyTestToken_(validVerifyPayload_({ iat: now, exp: now + 16 * 60 }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ttl_too_long');
});
test('R8#9：発行有効期間がちょうど15分（境界値）は拒否されない', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRawVerifyTestToken_(validVerifyPayload_({ iat: now, exp: now + 15 * 60 }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, true, JSON.stringify(r));
});
test('R8#9：jtiが欠損しているJWTは拒否される', () => {
  const payload = validVerifyPayload_();
  delete payload.jti;
  const token = signRawVerifyTestToken_(payload);
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jti');
});
test('R8#9：jtiが不正な形式（安全な16進数形式でない）のJWTは拒否される', () => {
  const token = signRawVerifyTestToken_(validVerifyPayload_({ jti: '<script>not-hex-and-has-symbols</script>' }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jti');
});
test('R8#9：jtiが短すぎる（32文字未満）JWTは拒否される', () => {
  const token = signRawVerifyTestToken_(validVerifyPayload_({ jti: 'abc123' }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jti');
});
test('R8#9：jtiが大文字を含む（signVerifyJwt()が実際に生成する小文字16進数形式と一致しない）JWTは拒否される', () => {
  const token = signRawVerifyTestToken_(validVerifyPayload_({ jti: 'A'.repeat(32) }));
  const r = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jti');
});
test('R8#9：jtiのワンタイム使用強制は未決事項のため実装しない（同一jtiでの複数回検証は、他のクレームが有効なら毎回okになることの確認。将来jti再利用防止を実装する場合はこのテストごと置き換えること）', () => {
  const token = signRawVerifyTestToken_(validVerifyPayload_());
  const r1 = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  const r2 = verifyVerifyJwt(token, SECRET, VERIFY_TEST_VERIFY_OPTS);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.jti, r2.jti);
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
 * buildLeadScoreBreakdownV2（単位D・独立監査再提出版：2026-09-07）
 * 独自の簡易スコア式（反応あり=高／3PV=中／それ以外=低）は監査差し戻しにより撤回した。
 * V1の判定式（computeLeadScore_）をそのまま呼ぶ設計へ全面改訂したため、
 * このテストブロックも全面的に書き直した。
 * =================================================================== */
test('契約テスト（単位D）：同一イベント集合ではV1(computeLeadScore_)とV2(buildLeadScoreBreakdownV2)のleadScore.levelが一致する（再訪なし）', async () => {
  const db = fakeFirestore();
  const visitId = 'v_lscontract_0001'.padEnd(20, '0');
  const rawVisitorId = 'v_lscontract_visitor_0001aaaaaaaa';
  const identity = evaluateVisitorIdentity(rawVisitorId, true);
  assert.equal(identity.hashReliable, true, '前提：hashReliable=trueな訪問者');
  const baseTime = new Date('2026-09-07T02:00:00.000Z').getTime();
  const pages = ['https://aoki-tosou.net/works.html', 'https://aoki-tosou.net/faq.html', 'https://aoki-tosou.net/'];

  for (let i = 0; i < pages.length; i++) {
    await recordWebEventV2(db, COLLECTIONS, makeEvent({
      eventId: `e_ls_pv_${i}`, visitId, eventType: 'page_view', occurredAt: baseTime + i * 1000,
      currentPage: pages[i], rawVisitorId, hashReliable: identity.hashReliable, visitorHash: identity.visitorHash
    }));
  }
  await recordWebEventV2(db, COLLECTIONS, makeEvent({
    eventId: 'e_ls_line', visitId, eventType: 'line_click', occurredAt: baseTime + 4000,
    rawVisitorId, hashReliable: identity.hashReliable, visitorHash: identity.visitorHash
  }));

  // fakeFirestoreの_dataはドキュメントの中身のみを保持し、ドキュメントID（visitId）は
  // 別管理のため、実際の呼び出し側（functions/index.jsのgetFunnelInsightsV2）が行うのと
  // 同様にvisitIdをdoc.id相当として明示的に合成する。
  const session = Object.assign({ visitId }, db._data.get(`visit_sessions/${visitId}`));
  assert.equal(session.pageViewCount, 3, '前提：3件のpage_view');
  assert.equal(session.lineClickCount, 1, '前提：line_click 1件');
  assert.deepEqual(session.pageCategories, pages.map((url) => pageCategoryOf_(pageKeyOf_(url))), 'V2が保持するpageCategoriesがV1のページ分類と一致すること');

  // V1側：同じイベント集合をV1の入力形状（pageCategories・actions・pageCount）で
  // 手動構成し、V1の実装（computeLeadScore_）をそのまま呼ぶ（再訪なし＝priorVisit=null）。
  const v1PageCategories = pages.map((url) => pageCategoryOf_(pageKeyOf_(url)));
  const v1Result = computeLeadScore_({ dayKey: jstDateKey(baseTime), pageCount: 3, pageCategories: v1PageCategories, actions: [{ type: 'lineClick' }] }, null);

  // V2側：recordWebEventV2が実際に保存したvisit_sessionを、V2の見込み度パイプラインへ
  // そのまま渡す（priorVisitSessions等は空＝再訪なし）。
  const v2Result = buildLeadScoreBreakdownV2([session], [], [], []);
  const v2Card = v2Result.cards.find((c) => c.visitId === visitId);

  assert.ok(v2Card, 'new_reliableな高中低いずれかのcardが生成されていること');
  assert.equal(v2Card.level, v1Result.level, 'V1とV2のleadScore.levelが一致すること');
});

test('契約テスト（単位D）：再訪ボーナス（前回より深い閲覧）もV1/V2で一致する', async () => {
  const db = fakeFirestore();
  const rawVisitorId = 'v_lscontract_revisit_0001aaaaaaaa';
  const identity = evaluateVisitorIdentity(rawVisitorId, true);
  const day1 = new Date('2026-09-05T02:00:00.000Z').getTime();
  const day2 = new Date('2026-09-07T02:00:00.000Z').getTime(); // 2日後の再訪

  // 前回訪問（1ページのみ・反応なし）
  const priorVisitId = 'v_lscontract_prior_0001'.padEnd(20, '0');
  await recordWebEventV2(db, COLLECTIONS, makeEvent({
    eventId: 'e_ls_prior_pv', visitId: priorVisitId, eventType: 'page_view', occurredAt: day1,
    currentPage: 'https://aoki-tosou.net/', rawVisitorId, hashReliable: identity.hashReliable, visitorHash: identity.visitorHash
  }));
  const priorSession = Object.assign({ visitId: priorVisitId }, db._data.get(`visit_sessions/${priorVisitId}`));

  // 今回訪問（3ページ・前回より深い閲覧）
  const currentVisitId = 'v_lscontract_current_0001'.padEnd(20, '0');
  const pages = ['https://aoki-tosou.net/', 'https://aoki-tosou.net/works.html', 'https://aoki-tosou.net/faq.html'];
  for (let i = 0; i < pages.length; i++) {
    await recordWebEventV2(db, COLLECTIONS, makeEvent({
      eventId: `e_ls_current_pv_${i}`, visitId: currentVisitId, eventType: 'page_view', occurredAt: day2 + i * 1000,
      currentPage: pages[i], rawVisitorId, hashReliable: identity.hashReliable, visitorHash: identity.visitorHash
    }));
  }
  const currentSession = Object.assign({ visitId: currentVisitId }, db._data.get(`visit_sessions/${currentVisitId}`));

  // V1側
  const v1Prior = { dayKey: jstDateKey(day1), pageCount: 1, hadAction: false };
  const v1PageCategories = pages.map((url) => pageCategoryOf_(pageKeyOf_(url)));
  const v1Result = computeLeadScore_({ dayKey: jstDateKey(day2), pageCount: 3, pageCategories: v1PageCategories, actions: [] }, v1Prior);
  assert.equal(v1Result.revisit.isReturning, true, '前提：V1側が再訪と判定していること');
  assert.equal(v1Result.revisit.deeperThanPrevious, true, '前提：V1側が「前回より深い閲覧」と判定していること');

  // V2側：priorVisitSessionsへ前回訪問を渡す
  const v2Result = buildLeadScoreBreakdownV2([currentSession], [priorSession], [], []);
  const v2Card = v2Result.cards.find((c) => c.visitId === currentVisitId);

  assert.ok(v2Card, '再訪込みでもnew_reliableなcardが生成されること');
  assert.equal(v2Card.level, v1Result.level, '再訪ボーナスを含めてもV1とV2のleadScore.levelが一致すること');
  // 独立監査再提出R6・項目10：revisitImprovedはこの「前回より深い閲覧」の再訪1件を数える。
  assert.equal(v2Result.revisitImproved, 1, 'revisitImproved（前回より深い閲覧／反応が強まった再訪の件数）が1になる');
});
test('buildLeadScoreBreakdownV2: revisitImprovedは初回訪問（再訪ではない）や判定不能・legacyを含めない', () => {
  const sessions = [
    { visitId: 'v_first', hashReliable: true, hasPageView: true, pageViewCount: 1, lineClickCount: 0, phoneClickCount: 0, reactionCount: 0, pageCategories: [null], startedAt: Date.now(), visitorHash: 'hash_first' },
    { visitId: 'v_unreliable', hashReliable: false, hasPageView: true, pageViewCount: 5, lineClickCount: 1, phoneClickCount: 0, reactionCount: 1, pageCategories: [], startedAt: Date.now() }
  ];
  const result = buildLeadScoreBreakdownV2(sessions, [], [], []);
  assert.equal(result.revisitImproved, 0, '初回訪問・判定不能（hashReliable=false）はrevisitImprovedへ計上されない');
});

test('buildLeadScoreBreakdownV2: hashReliable=falseのsessionは行動によらず判定不能へ集計され、cardsには含まれない（正本仕様：unreliable/hash欠損は判定不能）', () => {
  const sessions = [
    { visitId: 'v1', hashReliable: false, hasPageView: true, pageViewCount: 5, lineClickCount: 1, phoneClickCount: 1, reactionCount: 2, pageCategories: [] }
  ];
  const { counts, cards } = buildLeadScoreBreakdownV2(sessions, [], [], []);
  assert.equal(counts.判定不能, 1);
  assert.equal(counts.高, 0);
  assert.equal(cards.length, 0, 'hashReliable=falseはcards（個別カード）に含めない');
});
test('buildLeadScoreBreakdownV2: hashReliable=true・hasPageView=false（reaction-only）は判定不能（V1と同じ方針・閲覧文脈を捏造しない）', () => {
  const sessions = [
    { visitId: 'v_reaction_only', hashReliable: true, hasPageView: false, pageViewCount: 0, lineClickCount: 1, phoneClickCount: 0, reactionCount: 1, pageCategories: [] }
  ];
  const { counts, cards } = buildLeadScoreBreakdownV2(sessions, [], [], []);
  assert.equal(counts.判定不能, 1);
  assert.equal(cards.length, 0);
});
test('buildLeadScoreBreakdownV2: mediaValidity=invalidのcardはmediaCodeを生値のまま返さない（buildQualityAxesと同じ扱い）', () => {
  const sessions = [
    { visitId: 'v_invalid', hashReliable: true, hasPageView: true, pageViewCount: 1, lineClickCount: 1, phoneClickCount: 0, reactionCount: 1, pageCategories: [null], mediaCode: 'bad code', mediaValidity: 'invalid', webSource: '', webSourceStatus: 'invalid', startedAt: 1000 }
  ];
  const { cards } = buildLeadScoreBreakdownV2(sessions, [], [], []);
  assert.equal(cards[0].mediaCode, '', 'invalidなmediaCodeはcardへ生値のまま出さない');
});
test('buildLeadScoreBreakdownV2: 旧ログ（legacy_unknown）はV1のgroupVisits_と同じ日付＋visitor_hash単位でvisit集約される（raw log単位ではない）', () => {
  // 同一visitor_hash・同一日のpage_view行3件は、V1のgroupVisits_により「1visit」へ
  // 集約される（raw logは3件でもvisitは1件）。
  const legacyRows = [
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: 'hashA' },
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: 'hashA' },
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: 'hashA' },
    { eventType: 'page_view', dayKey: '2026-09-02', visitorHashValue: 'hashB' }
  ];
  const { counts } = buildLeadScoreBreakdownV2([], [], legacyRows, []);
  assert.equal(counts.旧ログ, 2, '同一visitor_hash・同一日の3行は1visitへ、別日・別visitorの1行は別visitへ＝計2visit');
});
test('buildLeadScoreBreakdownV2: legacy_hash_missingは「旧ログ」ではなく「判定不能」へ計上される（混ぜない）', () => {
  const legacyHashMissingRows = [
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: '' },
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: '' }
  ];
  const { counts } = buildLeadScoreBreakdownV2([], [], [], legacyHashMissingRows);
  assert.equal(counts.旧ログ, 0, 'legacy_hash_missingは旧ログへ混ぜない');
  // 独立監査再提出R6 #2で訂正：hash無しはgroupVisits_の共通"(不明)"キーへ集約せず、
  // page_view行を1行＝1visitとして個別カウントする。同日・visitor_hash空の
  // page_viewが2件なら判定不能は2件（1件へ潰れる旧仕様は誤りだった）。
  assert.equal(counts.判定不能, 2, '同一日・hash無しでも、hash無しの複数行を同一訪問とみなす根拠が無いため1行＝1visitとして個別カウントする（2行→2）');
});
test('buildLeadScoreBreakdownV2: legacy_hash_missingのpage_view以外（line_click等）はvisit数に数えない', () => {
  const legacyHashMissingRows = [
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: '' },
    { eventType: 'line_click', dayKey: '2026-09-01', visitorHashValue: '' }
  ];
  const { counts } = buildLeadScoreBreakdownV2([], [], [], legacyHashMissingRows);
  assert.equal(counts.判定不能, 1, 'page_view行のみを訪問としてカウントする（groupVisits_と同じeventType絞り込み方針）');
});
test('buildLeadScoreBreakdownV2: isTest===trueのvisit_sessionは全区分から除外される', () => {
  const sessions = [
    { visitId: 'v_test', isTest: true, hashReliable: true, hasPageView: true, pageViewCount: 1, lineClickCount: 1, phoneClickCount: 0, reactionCount: 1, pageCategories: [null], startedAt: Date.now() },
    { visitId: 'v_real', isTest: false, hashReliable: true, hasPageView: true, pageViewCount: 1, lineClickCount: 1, phoneClickCount: 0, reactionCount: 1, pageCategories: [null], startedAt: Date.now() }
  ];
  const { counts, cards } = buildLeadScoreBreakdownV2(sessions, [], [], []);
  assert.equal(cards.length, 1, 'isTest=trueのsessionはcardに含まれない');
  assert.equal(cards[0].visitId, 'v_real');
  const total = counts.高 + counts.中 + counts.低 + counts.判定不能;
  assert.equal(total, 1, 'isTest=trueのsessionはcounts集計にも含まれない');
});

/* ============================================================================
 * legacy backward compatibility（独立監査再提出R7・項目4）
 * ============================================================================ */
test('extractHostnameFromReferrer_: 完全なURLからホスト名を小文字で取り出す', () => {
  assert.equal(extractHostnameFromReferrer_('https://WWW.Google.com/search?q=x'), 'www.google.com');
});
test('extractHostnameFromReferrer_: 空文字は空文字のまま（例外を投げない）', () => {
  assert.equal(extractHostnameFromReferrer_(''), '');
  assert.equal(extractHostnameFromReferrer_(null), '');
  assert.equal(extractHostnameFromReferrer_(undefined), '');
});
test('extractHostnameFromReferrer_: URLとしてパースできない値（既にホスト名のみの旧値）はそのまま小文字化して使う', () => {
  assert.equal(extractHostnameFromReferrer_('Www.Bing.Com'), 'www.bing.com');
});

test('deriveLegacyMediaAndSource_: from有り・referrer無し→mediaValidity=valid・webSourceStatus=none（direct化しない）', () => {
  const result = deriveLegacyMediaAndSource_({ from: 'meishi', referrer: '' });
  assert.equal(result.mediaValidity, 'valid');
  assert.equal(result.mediaCode, 'meishi');
  assert.equal(result.webSourceStatus, 'none');
  assert.equal(result.webSource, '');
});
test('deriveLegacyMediaAndSource_: from無し・referrer無し→真の直接アクセス（webSourceStatus=direct）', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '' });
  assert.equal(result.mediaValidity, 'none');
  assert.equal(result.webSourceStatus, 'direct');
  assert.equal(result.webSource, 'direct');
});
test('deriveLegacyMediaAndSource_: from無し・referrer有り→webSourceStatus=referrer・ホスト名を保持', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: 'https://www.google.com/search?q=x' });
  assert.equal(result.mediaValidity, 'none');
  assert.equal(result.webSourceStatus, 'referrer');
  assert.equal(result.webSource, 'www.google.com');
});
test('deriveLegacyMediaAndSource_: from・referrer両方有り→両方保持する（V2のrawAttributionFromSignalと同じ契約）', () => {
  const result = deriveLegacyMediaAndSource_({ from: 'meishi', referrer: 'https://www.google.com/' });
  assert.equal(result.mediaCode, 'meishi');
  assert.equal(result.webSource, 'www.google.com');
  assert.equal(result.webSourceStatus, 'referrer');
});
test('deriveLegacyMediaAndSource_: 不正な形式のfromはmediaValidity=invalid・mediaCode=""（生値を保持しない）', () => {
  const result = deriveLegacyMediaAndSource_({ from: '<script>bad', referrer: '' });
  assert.equal(result.mediaValidity, 'invalid');
  assert.equal(result.mediaCode, '');
});

/* ===================================================================
 * 独立監査再提出R8・項目6：legacy source情報の欠落。
 * from保存開始（2026-08-31）より前のraw logはfromが空のままだが、V1クライアント
 * （js/analytics.js:currentAttribution()）が計算していたsource列（from／UTM／
 * referrer統合値）から、既存の検証ロジック（normalizeMediaCode/normalizeWebSource）
 * だけを使って安全に復元できる場合がある、という指摘への対応。
 * =================================================================== */
test('recoverLegacySourceLabel_: "direct"は非外部シグナルとして扱い、媒体・参照元どちらへも変換しない', () => {
  assert.deepEqual(recoverLegacySourceLabel_('direct'), { kind: 'none' });
});
test('recoverLegacySourceLabel_: "internal"（同一サイト内遷移）も非外部シグナルとして扱う', () => {
  assert.deepEqual(recoverLegacySourceLabel_('internal'), { kind: 'none' });
});
test('recoverLegacySourceLabel_: 空文字は非外部シグナルとして扱う', () => {
  assert.deepEqual(recoverLegacySourceLabel_(''), { kind: 'none' });
});
test('recoverLegacySourceLabel_: "meishi"（明示allowlistに載っている既知の媒体コード）は媒体コードとして復元する', () => {
  assert.deepEqual(recoverLegacySourceLabel_('meishi'), { kind: 'media', mediaCode: 'meishi' });
});
test('recoverLegacySourceLabel_: "google.com"（ドット有り・ホスト名形式）はWeb参照元として復元する（媒体コードにはならない。ドットはMEDIA_CODE_PATTERN不一致）', () => {
  assert.deepEqual(recoverLegacySourceLabel_('google.com'), { kind: 'source', webSource: 'google.com' });
});

/* ---- 独立監査再提出R9・項目5：「ドットなしなら媒体」という推測を撤回。曖昧な
 * 値はopaqueとして保持し、media/direct/webのいずれへも推測分類しない。 ---- */
test('R9#5：recoverLegacySourceLabel_: "不明"（referrerはあったがパース失敗＝情報はあるが判別不能）はopaqueとして保持する（直接アクセスへ推測分類しない）', () => {
  assert.deepEqual(recoverLegacySourceLabel_('不明'), { kind: 'opaque' });
});
test('R9#5：recoverLegacySourceLabel_: "google / cpc"（V1のUTM結合表記" / "）はopaque値として媒体・参照元どちらへも変換しない', () => {
  assert.deepEqual(recoverLegacySourceLabel_('google / cpc'), { kind: 'opaque' });
});
test('R9#5：recoverLegacySourceLabel_: 媒体コードにもホスト名にも一致しない値（記号を含む等）はopaqueとして保持する', () => {
  assert.deepEqual(recoverLegacySourceLabel_('!!!invalid???'), { kind: 'opaque' });
});
test('R9#5：recoverLegacySourceLabel_: UTM utm_source単独値（例："google"。ドットを含まず、明示allowlistにも無い）は媒体として復元しない（「ドットなしなら媒体」という推測の撤回）', () => {
  // V1のcurrentAttribution()は utm_medium が省略された場合、
  // [utmSource, utmMedium].filter(Boolean).join(' / ') が1要素配列になり、
  // ' / 'セパレータを含まないutm_sourceの生値単独（例："google"）がそのまま
  // source列へ入る。これは媒体コードではなくUTM値であり、media扱いしてはならない。
  assert.deepEqual(recoverLegacySourceLabel_('google'), { kind: 'opaque' }, 'ドットを含まず、allowlistにも無い"google"は媒体コードとして復元してはならない');
});
test('R9#5：recoverLegacySourceLabel_: 非文字列（数値・真偽値・オブジェクト等）はString()で媒体化せず、「情報無し」として扱う', () => {
  assert.deepEqual(recoverLegacySourceLabel_(12345), { kind: 'none' }, '数値をString()変換すると"12345"という一見ありそうな媒体コード形式の文字列になり得るため、型チェックで弾く');
  assert.deepEqual(recoverLegacySourceLabel_(true), { kind: 'none' });
  assert.deepEqual(recoverLegacySourceLabel_({ foo: 'bar' }), { kind: 'none' });
  assert.deepEqual(recoverLegacySourceLabel_(['meishi']), { kind: 'none' }, '配列も文字列ではないため媒体化しない（["meishi"]がString()で"meishi"になり得る経路を塞ぐ）');
  assert.deepEqual(recoverLegacySourceLabel_(null), { kind: 'none' });
  assert.deepEqual(recoverLegacySourceLabel_(undefined), { kind: 'none' });
});
test('R9#5：recoverLegacySourceLabel_: "direct"・"internal"は引き続き非外部シグナルとして扱う（確定的なラベルであり曖昧値ではないため回帰なし）', () => {
  assert.deepEqual(recoverLegacySourceLabel_('direct'), { kind: 'none' });
  assert.deepEqual(recoverLegacySourceLabel_('internal'), { kind: 'none' });
});

test('deriveLegacyMediaAndSource_（R8#6・ケース1）：from欠損＋source="meishi"→mediaCodeとして復元される', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '', source: 'meishi' });
  assert.equal(result.mediaValidity, 'valid');
  assert.equal(result.mediaCode, 'meishi');
});
test('deriveLegacyMediaAndSource_（R8#6・ケース2）：from欠損＋source="google.com"→webSourceとして復元される（媒体コードにはならない）', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '', source: 'google.com' });
  assert.equal(result.mediaValidity, 'none', '"google.com"は媒体コードとして復元しない（ドットを含むためMEDIA_CODE_PATTERN不一致）');
  assert.equal(result.mediaCode, '');
  assert.equal(result.webSourceStatus, 'referrer');
  assert.equal(result.webSource, 'google.com');
});
test('deriveLegacyMediaAndSource_（R8#6・ケース3）：from欠損＋source="direct"→そのまま直接アクセス（偽の媒体・参照元を作らない）', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '', source: 'direct' });
  assert.equal(result.mediaValidity, 'none');
  assert.equal(result.webSourceStatus, 'direct');
  assert.equal(result.webSource, 'direct');
});
test('deriveLegacyMediaAndSource_（R8#6・ケース4）：from欠損＋source="internal"→同一サイト内遷移を外部シグナルへ偽装しない（directのまま）', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '', source: 'internal' });
  assert.equal(result.mediaValidity, 'none');
  assert.equal(result.webSourceStatus, 'direct', '"internal"は外部Web参照元でも媒体でもないため、真の直接アクセスと同じdirect扱いのまま（"internal"という生値をwebSourceへ流用しない）');
});
test('deriveLegacyMediaAndSource_（R8#6・ケース5）：fromあり＋sourceが別値→fromが優先されsourceは無視される（V1のcurrentAttribution()と同じfrom優先規則）', () => {
  const result = deriveLegacyMediaAndSource_({ from: 'chirashi01', referrer: '', source: 'google.com' });
  assert.equal(result.mediaValidity, 'valid');
  assert.equal(result.mediaCode, 'chirashi01', 'fromが存在する場合、sourceの値（google.com）を一切参照しない');
  assert.equal(result.webSourceStatus, 'none', 'referrerも空なので、sourceから参照元を推測復元したりしない');
});
test('deriveLegacyMediaAndSource_（R8#6）：referrerフィールド自体が既に外部参照元を示している場合は、そちらを優先する（sourceからの復元より一次情報を信頼する）', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: 'https://www.yahoo.co.jp/', source: 'meishi' });
  // referrerが実際に存在する（=より信頼できる一次情報）ため、sourceが仮に別の値
  // （"meishi"＝媒体コード相当）を示していても、referrer由来のWeb参照元が優先される。
  assert.equal(result.webSourceStatus, 'referrer');
  assert.equal(result.webSource, 'www.yahoo.co.jp');
  // sourceの"meishi"はreferrerが存在する時点でrecoverLegacySourceLabel_のkind==='media'
  // 分岐が独立して評価され媒体コードとして復元される（referrer優先はwebSource側だけの
  // 話であり、媒体コード復元はreferrerの有無と無関係に働く。実データでは通常
  // fromが空でsourceが媒体コード相当の値を持つケース自体が稀＝from保存開始前は
  // 媒体コードがあればfrom相当としてsourceへ格納されていたはずのため、この組合せは
  // 理論上のfixtureであることを明示する）。
  assert.equal(result.mediaValidity, 'valid');
  assert.equal(result.mediaCode, 'meishi');
});
test('deriveLegacyMediaAndSource_（R8#6）：sourceフィールド自体が無い（未指定）行は、従来どおりfrom/referrerだけで判定される（後方互換・回帰なし）', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '' });
  assert.equal(result.mediaValidity, 'none');
  assert.equal(result.webSourceStatus, 'direct');
});

/* ---- 独立監査再提出R9・項目5：opaque legacy attribution（media/direct/webの
 * いずれへも推測分類しない曖昧値）。 ---- */
test('R9#5：deriveLegacyMediaAndSource_: from欠損＋source="google"（UTM utm_source単独値。ドット無し・allowlist外）→media/direct/webのいずれにも分類せずlegacy_opaqueとして保持する', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '', source: 'google' });
  assert.equal(result.mediaValidity, 'none', '"google"は媒体コードとして復元しない（UTM utm_source単独値の可能性を排除できないため）');
  assert.equal(result.mediaCode, '');
  assert.equal(result.webSourceStatus, 'legacy_opaque', '真の直接アクセス（direct）へも推測分類しない');
  assert.notEqual(result.webSourceStatus, 'direct');
  assert.equal(result.webSource, '', '生のsource値（"google"）をwebSourceへ入れない');
  assert.ok(result.legacyOpaqueSourceHash, '診断用ハッシュは残す（生値は保持しない）');
});
test('R9#5：deriveLegacyMediaAndSource_: from欠損＋source="不明"（referrerパース失敗）→legacy_opaqueとして保持する（directへ推測分類しない）', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '', source: '不明' });
  assert.equal(result.webSourceStatus, 'legacy_opaque');
  assert.equal(result.mediaValidity, 'none');
});
test('R9#5：deriveLegacyMediaAndSource_: from欠損＋source="google / cpc"（UTM結合表記）→legacy_opaqueとして保持する', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '', source: 'google / cpc' });
  assert.equal(result.webSourceStatus, 'legacy_opaque');
});
test('R9#5：deriveLegacyMediaAndSource_: 非文字列source（例：数値）はString()で媒体化されず、from/referrerだけの通常判定にfall backする', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: '', source: 12345 });
  assert.equal(result.mediaValidity, 'none');
  assert.equal(result.webSourceStatus, 'direct', '非文字列sourceは「情報無し」として扱われ、from/referrerとも無いので真の直接アクセスのまま');
  assert.notEqual(result.mediaCode, '12345');
});
test('R9#5：deriveLegacyMediaAndSource_: referrerフィールド自体が既に外部参照元を示している場合は、opaque判定よりそちらを優先する（一次情報を信頼する）', () => {
  const result = deriveLegacyMediaAndSource_({ from: '', referrer: 'https://www.yahoo.co.jp/', source: 'google' });
  assert.equal(result.webSourceStatus, 'referrer', 'referrerが実在するため、opaque（legacy_opaque）にはならない');
  assert.equal(result.webSource, 'www.yahoo.co.jp');
});
test('R9#5：buildQualityAxes: legacy_opaqueなセッションは"source:legacy_opaque"という独立したwebSourceQualityキーへ集計され、"source:direct"へは混入しない', () => {
  const opaqueSession = { hasPageView: true, reactionCount: 0, isTest: false, mediaCode: '', mediaValidity: 'none', webSource: '', webSourceStatus: 'legacy_opaque' };
  const directSession = { hasPageView: true, reactionCount: 0, isTest: false, mediaCode: '', mediaValidity: 'none', webSource: 'direct', webSourceStatus: 'direct' };
  const { webSourceQuality } = buildQualityAxes([opaqueSession, directSession]);
  const opaqueRow = webSourceQuality.find((s) => s.key === 'source:legacy_opaque');
  const directRow = webSourceQuality.find((s) => s.key === 'source:direct');
  assert.ok(opaqueRow, 'source:legacy_opaqueという独立したキーの行が存在する');
  assert.equal(opaqueRow.visits, 1);
  assert.ok(directRow, 'source:directの行も別途存在する');
  assert.equal(directRow.visits, 1, 'legacy_opaqueなセッションがsource:directへ混入していない（1のまま）');
});

test('buildLegacyPseudoSessions_: hash有り・同一visitor_hash同一日の3行は1visitへ集約される（V1のgroupVisits_と同じ単位）', () => {
  const rows = [
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: 'hashA', at: 1000, from: 'meishi', referrer: '' },
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: 'hashA', at: 2000, from: '', referrer: '' },
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: 'hashA', at: 3000, from: '', referrer: '' }
  ];
  const sessions = buildLegacyPseudoSessions_(rows, []);
  assert.equal(sessions.length, 1, '3行は1つの疑似セッションへ集約される');
  assert.equal(sessions[0].hasPageView, true);
  assert.equal(sessions[0].pageViewCount, 3);
  assert.equal(sessions[0].mediaCode, 'meishi', '訪問の媒体はグループ内最初のpage_view行（at最小）のfromを採用する（V1のbuildVisitSummary_と同じ規則）');
  assert.equal(sessions[0].startedAt, 1000);
  assert.equal(sessions[0].legacySource, 'legacy_hash_present');
});
test('buildLegacyPseudoSessions_: hash無しのpage_view行は1行＝1visitとして個別に扱う（(不明)キーで結合しない。独立監査再提出R6・項目2と同じ方針）', () => {
  const rows = [
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: '', at: 1000, from: 'meishi', referrer: '', docId: 'doc1' },
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: '', at: 2000, from: 'meishi', referrer: '', docId: 'doc2' }
  ];
  const sessions = buildLegacyPseudoSessions_([], rows);
  assert.equal(sessions.length, 2, '同一日・hash空の2行は2つの独立した疑似セッションになる（1つに潰れない）');
  assert.notEqual(sessions[0].legacyVisitId, sessions[1].legacyVisitId, '各行が別々の疑似visitIdを持つ');
  assert.equal(sessions.every((s) => s.legacySource === 'legacy_hash_missing'), true);
});
test('buildLegacyPseudoSessions_: line_click/phone_click行は訪問へ結合せず、reaction-onlyの疑似セッションとして個別に追加される', () => {
  const hashPresentRows = [
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: 'hashA', at: 1000, from: 'meishi', referrer: '' },
    { eventType: 'line_click', dayKey: '2026-09-01', visitorHashValue: 'hashA', at: 1500, from: 'meishi', referrer: '', docId: 'reactDoc1' }
  ];
  const sessions = buildLegacyPseudoSessions_(hashPresentRows, []);
  assert.equal(sessions.length, 2, '訪問1件＋reaction-only 1件の計2つの疑似セッションになる（reactionが訪問へ吸収されない）');
  const visitSession = sessions.find((s) => s.legacySource === 'legacy_hash_present');
  const reactionSession = sessions.find((s) => s.legacySource === 'legacy_reaction');
  assert.ok(visitSession && reactionSession);
  assert.equal(visitSession.hasPageView, true);
  assert.equal(visitSession.reactionCount, 0, '訪問側はreactionを推測結合しない（0のまま）');
  assert.equal(reactionSession.hasPageView, false);
  assert.equal(reactionSession.reactionCount, 1);
  assert.equal(reactionSession.legacyReactionEventType, 'line_click');
  assert.notEqual(reactionSession.legacyVisitId, visitSession.legacyVisitId, 'reaction-onlyは訪問とは別の疑似ID（推測結合していないことの確認）');
});

test('件数包含関係：buildQualityAxes(V2セッション+legacy疑似セッション)のvisits/lineOrPhoneReactionsは、V2単独・legacy単独それぞれの合計以上になる（legacyが実際に合流していることの確認）', () => {
  const v2Sessions = [
    { visitId: 'v2_1', hashReliable: true, hasPageView: true, mediaCode: 'meishi', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none', reactionCount: 0, isTest: false }
  ];
  const legacyHashPresentRows = [
    { eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: 'hashA', at: 1000, from: 'meishi', referrer: '' },
    { eventType: 'page_view', dayKey: '2026-09-02', visitorHashValue: 'hashB', at: 2000, from: 'meishi', referrer: '' }
  ];
  const legacySessions = buildLegacyPseudoSessions_(legacyHashPresentRows, []);
  const v2Only = buildQualityAxes(v2Sessions);
  const legacyOnly = buildQualityAxes(legacySessions);
  const merged = buildQualityAxes(v2Sessions.concat(legacySessions));

  const v2OnlyVisits = v2Only.mediaQuality.find((m) => m.key === 'media:meishi').visits;
  const legacyOnlyVisits = legacyOnly.mediaQuality.find((m) => m.key === 'media:meishi').visits;
  const mergedVisits = merged.mediaQuality.find((m) => m.key === 'media:meishi').visits;

  assert.equal(v2OnlyVisits, 1);
  assert.equal(legacyOnlyVisits, 2);
  assert.equal(mergedVisits, v2OnlyVisits + legacyOnlyVisits, '同一媒体キーの下でV2とlegacyが合算される（3件）＝実際に合流していることの確認（件数包含関係）');
  assert.ok(mergedVisits >= v2OnlyVisits && mergedVisits >= legacyOnlyVisits, '合流後の件数は、どちらか一方だけの件数を下回らない（包含関係）');
});
test('件数包含関係：legacy疑似セッションはisTestフィルタを迂回しない（isTest:falseを明示的に持つ）', () => {
  const legacySessions = buildLegacyPseudoSessions_([{ eventType: 'page_view', dayKey: '2026-09-01', visitorHashValue: 'h', at: 1, from: '', referrer: '' }], []);
  assert.equal(legacySessions[0].isTest, false);
});
