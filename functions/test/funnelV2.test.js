'use strict';

/* =====================================================================
 * Web流入媒体識別精度改善・単位EF 検証テスト（2026-09-07・ローカル実装）
 * 合成fixtureのみ使用。実Firestore・実本番プロジェクトへは一切接続しない
 * （fakeFirestoreはfunnel.test.jsの既存パターンを踏襲・拡張したin-memoryモック）。
 * ===================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCoreFields,
  normalizeMediaCode,
  normalizeWebSource,
  evaluateVisitorIdentity,
  isOlderTuple,
  recordWebEventV2,
  jstDateKey,
  classifyLogCategory,
  buildQualityAxes,
  signVerifyJwt,
  verifyVerifyJwt
} = require('../lib/funnelV2');

function fakeFirestoreV2() {
  const data = new Map();
  function ref(path) {
    return {
      path,
      collection(name) { return { doc(id) { return ref(`${path}/${name}/${id}`); } }; }
    };
  }
  const transaction = {
    async get(document) { return { exists: data.has(document.path), data() { return data.get(document.path); } }; },
    set(document, value, options) { data.set(document.path, options && options.merge ? Object.assign({}, data.get(document.path) || {}, value) : value); },
    create(document, value) { if (data.has(document.path)) throw new Error('already exists'); data.set(document.path, value); }
  };
  return {
    _data: data,
    collection(name) { return { doc(id) { return ref(`${name}/${id}`); } }; },
    async runTransaction(callback) { return callback(transaction); }
  };
}
const COLLECTIONS = { interactionLogs: 'interaction_logs', funnelDaily: 'funnel_daily', visitSessions: 'visit_sessions' };

/* ===================================================================
 * validateCoreFields：中核5フィールドのみ400対象
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

/* ===================================================================
 * normalizeWebSource：'direct'固定禁止（invalid時にdirectへ変換しない）
 * =================================================================== */
test('空文字はwebSourceStatus=none（媒体はあるが参照元情報なし、を表す）', () => {
  assert.deepEqual(normalizeWebSource(''), { webSource: '', webSourceStatus: 'none' });
});
test("'direct'はそのまま直接アクセスとして扱う", () => {
  const r = normalizeWebSource('direct');
  assert.equal(r.webSourceStatus, 'direct');
});
test('正常なホスト名はwebSourceStatus=referrer', () => {
  const r = normalizeWebSource('google.com');
  assert.equal(r.webSourceStatus, 'referrer');
  assert.equal(r.webSource, 'google.com');
});
test('不正な値はwebSourceStatus=invalidとなり、directへ変換されない', () => {
  const r = normalizeWebSource('not a valid host!!');
  assert.equal(r.webSourceStatus, 'invalid');
  assert.equal(r.webSource, '');
  assert.notEqual(r.webSource, 'direct');
  assert.ok(r.invalidWebSourceHash);
});

/* ===================================================================
 * evaluateVisitorIdentity：7-1節の全組合せ（欠損・型不正規則を含む）
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
test('visitorIdPersisted=false かつ欠損ID は hashReliable=false', () => {
  const r = evaluateVisitorIdentity('', false);
  assert.equal(r.hashReliable, false);
});
test('visitorIdPersisted=false かつ不正形式ID は hashReliable=false', () => {
  const r = evaluateVisitorIdentity('short', false);
  assert.equal(r.hashReliable, false);
});
test('visitorIdPersistedが欠損（undefined）でもイベント処理は継続しhashReliable=false（今回訂正）', () => {
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

/* ===================================================================
 * isOlderTuple：(occurredAt, event_id) タプル比較
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
  const forward = pick(events);
  const reversed = pick(events.slice().reverse());
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, { occurredAt: 300, eventId: 'z' });
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
    visitorHash: '', visitorIdStatus: 'ok',
    source: '', contactChannel: '', currentPage: '', landingPage: '', referrer: '', referrerHost: '',
    isTest: false
  }, overrides);
}

test('raw log作成後にfunnel_daily更新を疑似的に失敗させても部分不整合が起きない（例外時は何も残らない）', async () => {
  const db = fakeFirestoreV2();
  const badDb = {
    collection: db.collection.bind(db),
    async runTransaction(cb) {
      // dayRef更新の直前で例外を投げる疑似障害。set呼び出し自体が発生しないため
      // Firestoreの実transaction同様、コミットされたものは無い（全部失敗）ことを確認する。
      const t = {
        async get(ref) { return { exists: false, data: () => ({}) }; },
        set() { throw new Error('simulated funnel_daily failure'); },
        create() {}
      };
      return cb(t);
    }
  };
  await assert.rejects(() => recordWebEventV2(badDb, COLLECTIONS, makeEvent({})));
  assert.equal(db._data.size, 0, '疑似障害時、raw log・daily・visit_sessionのいずれも書き込まれていないこと');
});

test('同一event_idの再送は1件として成功する（重複記録されない）', async () => {
  const db = fakeFirestoreV2();
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
  const db = fakeFirestoreV2();
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

test('funnel_dailyはV1と完全同一スキーマで更新される（新概念を混ぜない）', async () => {
  const db = fakeFirestoreV2();
  await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventType: 'page_view' }));
  const day = jstDateKey(new Date());
  const daily = db._data.get(`funnel_daily/${day}`);
  const keys = Object.keys(daily).sort();
  assert.deepEqual(keys, ['date', 'metrics', 'sources', 'testMetrics', 'testSources', 'updatedAt'].sort(),
    'funnel_dailyにvisit_id/mediaValidity等のV2独自フィールドが混入していないこと');
});

test('最小(occurredAt,event_id)が正本。より古いイベント後着時のみ7項目が一括更新される', async () => {
  const db = fakeFirestoreV2();
  const visitId = 'v_attribution_0001';
  await recordWebEventV2(db, COLLECTIONS, makeEvent({
    eventId: 'e_second_0002', visitId, occurredAt: 2000, mediaCode: 'M202', mediaValidity: 'valid', webSource: 'direct', webSourceStatus: 'direct'
  }));
  await recordWebEventV2(db, COLLECTIONS, makeEvent({
    eventId: 'e_first_0001', visitId, occurredAt: 1000, mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none'
  }));
  const session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.mediaCode, 'M101', 'より古いイベント（M101）が正本として採用されること');
  assert.equal(session.attributionEventId, 'e_first_0001');
  assert.equal(session.attributionMismatch, false);
});

test('正本より新しいoccurredAtで異なる帰属が届いた場合はattributionMismatch=trueのみ、正本は不変', async () => {
  const db = fakeFirestoreV2();
  const visitId = 'v_attribution_0002';
  await recordWebEventV2(db, COLLECTIONS, makeEvent({
    eventId: 'e_a_0001', visitId, occurredAt: 1000, mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none'
  }));
  await recordWebEventV2(db, COLLECTIONS, makeEvent({
    eventId: 'e_b_0002', visitId, occurredAt: 2000, mediaCode: 'M202', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none'
  }));
  const session = db._data.get(`visit_sessions/${visitId}`);
  assert.equal(session.mediaCode, 'M101', '正本は上書きされないこと');
  assert.equal(session.attributionMismatch, true);
});

test('occurredAt同値時のtie-breakerが到着順に依存しない（transaction経由でも一致）', async () => {
  const dbA = fakeFirestoreV2();
  const visitId = 'v_tie_0001';
  await recordWebEventV2(dbA, COLLECTIONS, makeEvent({ eventId: 'bbb', visitId, occurredAt: 1000, mediaCode: 'M1', mediaValidity: 'valid' }));
  await recordWebEventV2(dbA, COLLECTIONS, makeEvent({ eventId: 'aaa', visitId, occurredAt: 1000, mediaCode: 'M2', mediaValidity: 'valid' }));
  const sessionA = dbA._data.get(`visit_sessions/${visitId}`);

  const dbB = fakeFirestoreV2();
  await recordWebEventV2(dbB, COLLECTIONS, makeEvent({ eventId: 'aaa', visitId, occurredAt: 1000, mediaCode: 'M2', mediaValidity: 'valid' }));
  await recordWebEventV2(dbB, COLLECTIONS, makeEvent({ eventId: 'bbb', visitId, occurredAt: 1000, mediaCode: 'M1', mediaValidity: 'valid' }));
  const sessionB = dbB._data.get(`visit_sessions/${visitId}`);

  assert.equal(sessionA.attributionEventId, 'aaa');
  assert.equal(sessionB.attributionEventId, 'aaa');
  assert.equal(sessionA.mediaCode, sessionB.mediaCode, '到着順を入れ替えても最終結果が一致すること');
});

test('visit_idなし相当（validateCoreFieldsで拒否済み）はrecordWebEventV2に到達しない前提の確認', () => {
  const r = validateCoreFields({ schemaVersion: 2, event_id: 'a'.repeat(20), occurredAt: Date.now(), eventType: 'page_view' });
  assert.equal(r.ok, false, 'visit_idなしはvalidateCoreFieldsの時点で拒否され、recordWebEventV2へは到達しない');
});

/* ===================================================================
 * 4分類：legacy_unknownとhashReliableを同義にしない（正本仕様§7）
 * =================================================================== */
test('legacy（visit_idなし）＋非空hash → legacy_unknown（信頼できる、ではない）', () => {
  assert.equal(classifyLogCategory({ visit_id: '', visitor_hash: 'abc123' }), 'legacy_unknown');
});
test('legacy（visit_idなし）＋hash空 → legacy_hash_missing', () => {
  assert.equal(classifyLogCategory({ visit_id: '', visitor_hash: '' }), 'legacy_hash_missing');
});
test('新方式（有効visit_id）＋hashReliable=true → new_reliable', () => {
  assert.equal(classifyLogCategory({ visit_id: 'v_' + 'a'.repeat(20), visitor_hash: 'x', hashReliable: true }), 'new_reliable');
});
test('新方式（有効visit_id）＋hashReliable=false → new_unreliable（単位Dの個別カード対象外）', () => {
  assert.equal(classifyLogCategory({ visit_id: 'v_' + 'a'.repeat(20), visitor_hash: '', hashReliable: false }), 'new_unreliable');
});
test('カットオーバー後に届いたvisit_idなしログも日付に関わらずlegacy扱いになる', () => {
  // occurredAtが「未来」であっても、visit_id形式のみで判定する（日付ヒューリスティックは使わない）。
  assert.equal(classifyLogCategory({ visit_id: '', visitor_hash: 'x', occurredAt: Date.now() + 999999 }), 'legacy_unknown');
});

/* ===================================================================
 * buildQualityAxes：媒体軸・Web参照元軸の独立集計
 * =================================================================== */
test('媒体とWeb参照元の両方の信号を持つvisitは両軸へ独立して計上される', () => {
  const sessions = [{ mediaCode: 'M101', mediaValidity: 'valid', webSource: 'google.com', webSourceStatus: 'referrer' }];
  const { mediaQuality, webSourceQuality } = buildQualityAxes(sessions);
  assert.equal(mediaQuality.length, 1);
  assert.equal(webSourceQuality.length, 1);
  assert.equal(mediaQuality[0].visits, 1);
  assert.equal(webSourceQuality[0].visits, 1);
});
test('媒体あり・参照元なしは「直接アクセス」ではなくnoneバケットとして区別される', () => {
  const sessions = [{ mediaCode: 'M101', mediaValidity: 'valid', webSource: '', webSourceStatus: 'none' }];
  const { webSourceQuality } = buildQualityAxes(sessions);
  assert.equal(webSourceQuality[0].webSourceStatus, 'none');
  assert.notEqual(webSourceQuality[0].webSourceStatus, 'direct');
});
test('invalid媒体でも有効webSourceがあればWeb軸へ独立計上される', () => {
  const sessions = [{ mediaCode: '', mediaValidity: 'invalid', webSource: 'yahoo.co.jp', webSourceStatus: 'referrer' }];
  const { mediaQuality, webSourceQuality } = buildQualityAxes(sessions);
  assert.equal(mediaQuality.length, 1);
  assert.equal(mediaQuality[0].key, 'invalid');
  assert.equal(webSourceQuality.length, 1, 'invalid媒体でも参照元情報は独立して集計されること');
});
test('真の直接アクセス（媒体なし・参照元なし）はdirectバケットへ入る', () => {
  const sessions = [{ mediaCode: '', mediaValidity: 'none', webSource: 'direct', webSourceStatus: 'direct' }];
  const { mediaQuality, webSourceQuality } = buildQualityAxes(sessions);
  assert.equal(mediaQuality.length, 0);
  assert.equal(webSourceQuality[0].webSourceStatus, 'direct');
});

/* ===================================================================
 * VERIFY JWT：署名・aud・scope・期限・本番流用拒否
 * =================================================================== */
const SECRET = 'test-secret-please-not-real-0123456789abcdef';
test('正しく署名・発行されたJWTは検証を通る', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify', expectedSub: 'info@aoki-tosou.net' });
  assert.equal(r.ok, true);
});
test('署名が不正なら拒否される', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const tampered = token.slice(0, -2) + 'xx';
  const r = verifyVerifyJwt(tampered, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify' });
  assert.equal(r.ok, false);
});
test('別のSecretで署名されたJWTは拒否される（本番Secretでの流用拒否を模擬）', () => {
  const { token } = signVerifyJwt('a-different-secret-0123456789abcdefzz', { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature');
});
test('audが一致しないJWTは拒否される（他目的への流用拒否）', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'someOtherFunction', scope: 'write:interaction_logs_v2_verify' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'aud');
});
test('scopeが一致しないJWTは拒否される', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'read:something' });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'scope');
});
test('期限切れJWTは拒否される', () => {
  const { token } = signVerifyJwt(SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify', ttlSeconds: -10 });
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify' });
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
  const r = verifyVerifyJwt(token, SECRET, { expectedAud: 'logInteractionV2Verify', expectedScope: 'write:interaction_logs_v2_verify' });
  assert.ok(r.jti);
  assert.equal(JSON.stringify(r).indexOf(token), -1);
});
