'use strict';
/* =====================================================================
 * 監査差し戻し「修正後に行うREAD ONLY確認」対応：Firestore Emulator上での
 * 同時transaction・重複event_id・遅延到着・reaction先着の合成データ検証（2026-09-07）。
 * 実行方法：firebase emulators:exec --only firestore "node test/emulator_readonly_check_20260907.js"
 * fakeFirestoreV2（in-memoryモック）ではなく、実際のfirebase-admin SDK経由でFirestore
 * Emulatorへ接続し、本物のtransaction競合・リトライ機構を通す。実本番プロジェクトへは
 * 一切接続しない（FIRESTORE_EMULATOR_HOSTが設定されている場合のみ実行し、無ければ
 * 安全のため即座に失敗させる）。
 * ===================================================================== */
const assert = require('node:assert/strict');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST未設定。emulator経由でのみ実行すること（本番誤接続防止）。');
  process.exit(1);
}

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
initializeApp({ projectId: 'demo-funnel-media-precision-v1-audit' });
const db = getFirestore();

const { recordWebEventV2, jstDateKey, isOlderTuple } = require('../lib/funnelV2');
const COLLECTIONS = { interactionLogs: 'interaction_logs_emu_check', funnelDaily: 'funnel_daily_emu_check', visitSessions: 'visit_sessions_emu_check' };

const results = [];
function ok(name, condition, detail) { results.push({ name, ok: !!condition, detail: detail || '' }); }

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

async function clearCollections() {
  for (const name of Object.values(COLLECTIONS)) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function main() {
  await clearCollections();

  // --- 1. 同時transaction：同一visit_idへ2件を並行送信しても両方安全に処理される ---
  // 監査差し戻し（R2 #4）：旧アサーションは「M1かM2のどちらか」でPASSしてしまい、
  // occurredAtの新旧比較（isOlderTuple）が到着順に依存せず正しく機能していることを
  // 証明していなかった。occurredAtがより古いM1（e_concurrent_a）が、コミット順序に
  // 関わらず最終的に正本になることを厳密に確認する。
  {
    const visitId = 'v_concurrent_0001';
    const now = Date.now();
    const day = jstDateKey(new Date(now));
    const dayRefBefore = await db.collection(COLLECTIONS.funnelDaily).doc(day).get();
    const pageViewsBefore = dayRefBefore.exists ? Number(dayRefBefore.data().metrics.pageViews || 0) : 0;

    const [r1, r2] = await Promise.all([
      recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_concurrent_a', visitId, occurredAt: now, mediaCode: 'M1', mediaValidity: 'valid' })),
      recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_concurrent_b', visitId, occurredAt: now + 1, mediaCode: 'M2', mediaValidity: 'valid' }))
    ]);
    ok('同時transaction: 両方とも例外を投げず完了する', r1.recorded === true && r2.recorded === true, JSON.stringify([r1, r2]));

    const sessionSnap = await db.collection(COLLECTIONS.visitSessions).doc(visitId).get();
    const sessionData = sessionSnap.exists ? sessionSnap.data() : null;
    ok('同時transaction: occurredAtがより古いイベント（M1/e_concurrent_a）がコミット順序に関わらず最終的に正本になる',
      !!sessionData && sessionData.mediaCode === 'M1' && sessionData.attributionEventId === 'e_concurrent_a',
      JSON.stringify(sessionData));

    const dayRefAfter = await db.collection(COLLECTIONS.funnelDaily).doc(day).get();
    const pageViewsAfter = Number(dayRefAfter.data().metrics.pageViews || 0);
    ok('同時transaction: 2件とも別event_idの正規イベントとしてfunnel_dailyへ厳密に+2加算される（誤って1件に潰れていない）',
      pageViewsAfter === pageViewsBefore + 2, `before=${pageViewsBefore} after=${pageViewsAfter}`);
  }

  // --- 2. 重複event_id：同一event_idを連続送信しても2件目はduplicateとして扱われる ---
  // 監査差し戻し（R2 #4）：旧アサーションは`pageViews >= 1`のみで、シナリオ1が既に
  // 同日のpageViewsを増やしていたため、二重加算されていてもPASSし得た。前後の値を
  // 比較し、厳密に+1のみ増加することを確認する。
  {
    const event = makeEvent({ eventId: 'e_dup_check_0001' });
    const day = jstDateKey(new Date());
    const dayRefBefore = await db.collection(COLLECTIONS.funnelDaily).doc(day).get();
    const pageViewsBefore = dayRefBefore.exists ? Number(dayRefBefore.data().metrics.pageViews || 0) : 0;

    const r1 = await recordWebEventV2(db, COLLECTIONS, event);
    const r2 = await recordWebEventV2(db, COLLECTIONS, event);
    ok('重複event_id: 1件目は成功', r1.recorded === true);
    ok('重複event_id: 2件目はduplicateとして扱われる', r2.recorded === false && r2.duplicate === true);

    const dailySnap = await db.collection(COLLECTIONS.funnelDaily).doc(day).get();
    const pageViewsAfter = Number(dailySnap.data().metrics.pageViews || 0);
    ok('重複event_id: funnel_dailyのpageViewsが厳密に+1のみ増加する（二重加算されていない）',
      pageViewsAfter === pageViewsBefore + 1, `before=${pageViewsBefore} after=${pageViewsAfter}`);
  }

  // --- 3. 遅延到着：occurredAtが古いイベントが後から届いても正しく正本が補正される ---
  {
    const visitId = 'v_delayed_0001';
    await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_delayed_late_arrival_new', visitId, occurredAt: 2000, mediaCode: 'NEW', mediaValidity: 'valid' }));
    await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_delayed_late_arrival_old', visitId, occurredAt: 1000, mediaCode: 'OLD', mediaValidity: 'valid' }));
    const sessionSnap = await db.collection(COLLECTIONS.visitSessions).doc(visitId).get();
    ok('遅延到着: より古いoccurredAtを持つイベントが後着しても正本として採用される', sessionSnap.data().mediaCode === 'OLD', JSON.stringify(sessionSnap.data()));
  }

  // --- 4. reaction先着：page_viewより先にline_clickが届いてもhasPageViewは正しく管理される ---
  {
    const visitId = 'v_reaction_first_emu_0001';
    await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_reaction_first_click', visitId, eventType: 'line_click', occurredAt: 1000, mediaCode: 'M3', mediaValidity: 'valid' }));
    let sessionSnap = await db.collection(COLLECTIONS.visitSessions).doc(visitId).get();
    ok('reaction先着: line_click単体ではhasPageView=falseのまま', sessionSnap.data().hasPageView === false);
    await recordWebEventV2(db, COLLECTIONS, makeEvent({ eventId: 'e_reaction_first_pv', visitId, eventType: 'page_view', occurredAt: 1500, mediaCode: 'M3', mediaValidity: 'valid' }));
    sessionSnap = await db.collection(COLLECTIONS.visitSessions).doc(visitId).get();
    ok('reaction先着: 後発page_viewでhasPageView=trueへ昇格する', sessionSnap.data().hasPageView === true);
  }

  await clearCollections();

  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? ' :: ' + r.detail : '')));
  console.log('TOTAL ' + results.length + ' PASS ' + (results.length - failed.length) + ' FAIL ' + failed.length);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => { console.error('EMULATOR_CHECK_FATAL_ERROR', err); process.exitCode = 1; });
