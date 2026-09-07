'use strict';
/* =====================================================================
 * 単位EF「EF検証・段階切替」対応：検証用analytics相当payload→V2 writer（実HTTP）→
 * 隔離Firestore→V2 reader（実HTTP）の一気通貫確認（2026-09-07）。
 * Firebase Functions Emulator + Firestore Emulatorを両方起動した状態で実行する：
 *   firebase emulators:exec --only functions,firestore
 *     "node test/emulator_v2_e2e_20260907.js"
 * 実本番プロジェクト・実Secret Managerへは一切接続しない
 * （functions/.env.localのローカル専用ダミー値のみを使う）。
 * ===================================================================== */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { signVerifyJwt } = require('../lib/funnelV2');

// emulators:execはFunctions Emulator自身のランタイムへは.secret.localを読み込むが、
// このスクリプト自身のNodeプロセスへは読み込まないため、ここで明示的に読み込む
// （このスクリプト内でJWT署名にVERIFY_JWT_SECRETを使うため必要）。
(function loadDotEnvLocal() {
  const envPath = path.join(__dirname, '..', '.secret.local');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq < 0) return;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  });
})();

const project = process.env.GCLOUD_PROJECT || 'demo-aokitosou';
const base = `http://127.0.0.1:5001/${project}/us-central1`;
const db = getFirestore(initializeApp({ projectId: project }, 'v2-e2e-test'));

const VERIFY_SECRET = process.env.VERIFY_JWT_SECRET;
if (!VERIFY_SECRET) {
  console.error('VERIFY_JWT_SECRET未設定（functions/.env.localが読み込まれていない）。中止。');
  process.exit(1);
}

async function request(name, options) {
  return fetch(`${base}/${name}`, options);
}

function randomSuffix() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const results = [];
function ok(name, condition, detail) { results.push({ name, ok: !!condition, detail: detail || '' }); }

async function main() {
  const visitId = 'v2e2e_' + randomSuffix() + '0000000000';
  const visitorId = 'vid2e2e_' + randomSuffix() + '0000000000';

  // --- 1. PROD V2 writer（logInteractionV2）：Originなしは拒否 ---
  {
    const res = await request('logInteractionV2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 2, event_id: 'e2e_noorigin_' + randomSuffix(), visit_id: visitId, occurredAt: Date.now(), eventType: 'page_view' })
    });
    ok('logInteractionV2: Origin未許可は403', res.status === 403, 'status=' + res.status);
  }

  // --- 2. PROD V2 writer：正常なpage_view ---
  {
    const eventId = 'e2e_pv_' + randomSuffix();
    const res = await request('logInteractionV2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://aoki-tosou.net' },
      body: JSON.stringify({
        schemaVersion: 2, event_id: eventId, visit_id: visitId, occurredAt: Date.now(), eventType: 'page_view',
        visitMediaCode: 'meishi', visitWebSource: 'direct', visitorId, visitorIdPersisted: true,
        currentPage: 'https://aoki-tosou.net/', landingPage: 'https://aoki-tosou.net/', referrerHost: ''
      })
    });
    const body = await res.json();
    ok('logInteractionV2: 正常page_viewは200', res.status === 200 && body.success === true, JSON.stringify(body));

    const session = (await db.collection('visit_sessions').doc(visitId).get()).data();
    ok('logInteractionV2: visit_sessionsへ実際に書き込まれる（PROD collection）', !!session && session.mediaCode === 'meishi' && session.hashReliable === true, JSON.stringify(session));

    const rawLog = (await db.collection('interaction_logs').doc(eventId).get()).data();
    ok('logInteractionV2: interaction_logsへhash_reliable(snake_case)が保存される', !!rawLog && rawLog.hash_reliable === true, JSON.stringify(rawLog));
  }

  // --- 3. PROD V2 writer：型不正payload（監査差し戻しR2 #1の実例そのもの）はソフト縮退する ---
  {
    const eventId = 'e2e_badtype_' + randomSuffix();
    const res = await request('logInteractionV2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://aoki-tosou.net' },
      body: JSON.stringify({
        schemaVersion: 2, event_id: eventId, visit_id: 'v2e2e_badtype_' + randomSuffix() + '0000000000', occurredAt: Date.now(), eventType: 'page_view',
        visitMediaCode: 123, visitWebSource: 123, visitorId: 1234567890123456, visitorIdPersisted: true
      })
    });
    const body = await res.json();
    ok('logInteractionV2: 型不正payloadでも400にならず200（ソフト縮退）', res.status === 200, JSON.stringify(body));
    const rawLog = (await db.collection('interaction_logs').doc(eventId).get()).data();
    ok('logInteractionV2: 数値123のvisitMediaCodeは実HTTP経由でもfrom=""へ縮退する（正常media扱いに昇格しない）', rawLog && rawLog.from === '' && rawLog.media_validity === 'invalid', JSON.stringify(rawLog));
    ok('logInteractionV2: 数値visitorIdは実HTTP経由でもhash_reliable=falseへ縮退する', rawLog && rawLog.hash_reliable === false, JSON.stringify(rawLog));
  }

  // --- 3b. 独立監査再提出・項目7：クライアントのreferrerHost生値は保存されない
  // （webSourceStatusが'none'ならreferrer_hostは常に''。webSourceに悪意ある生値
  // 〔userinfo等〕を送っても、webSourceの検証を通らなければreferrer_hostへは残らない）。 ---
  {
    const eventId = 'e2e_referrerhost_' + randomSuffix();
    const res = await request('logInteractionV2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://aoki-tosou.net' },
      body: JSON.stringify({
        schemaVersion: 2, event_id: eventId, visit_id: 'v2e2e_refh_' + randomSuffix() + '0000000000', occurredAt: Date.now(), eventType: 'page_view',
        visitMediaCode: 'meishi', visitWebSource: '', visitorId: 'vidrefh_' + randomSuffix() + '0000000000', visitorIdPersisted: true,
        referrerHost: 'evil.example.com/?x=1#frag' // 生値を直接送っても、サーバーはこれを一切参照しない設計
      })
    });
    ok('logInteractionV2: referrerHostフィールドを送っても200（無視されるだけで拒否はしない）', res.status === 200);
    const rawLog = (await db.collection('interaction_logs').doc(eventId).get()).data();
    ok('logInteractionV2: visitWebSource=""（webSourceStatus=none）の場合、referrer_hostは常に""（クライアントの生値を保存しない）', rawLog && rawLog.referrer_host === '', JSON.stringify(rawLog));
  }

  // --- 4. VERIFY writer（logInteractionV2Verify）：JWTなしは401・jtiを含まない ---
  {
    const res = await request('logInteractionV2Verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 2, event_id: 'e2e_verify_noauth_' + randomSuffix(), visit_id: visitId, occurredAt: Date.now(), eventType: 'page_view' })
    });
    const body = await res.json();
    ok('logInteractionV2Verify: JWTなしは401', res.status === 401, 'status=' + res.status);
    ok('logInteractionV2Verify: 401レスポンスにjtiが含まれない', !Object.prototype.hasOwnProperty.call(body, 'jti'), JSON.stringify(body));
  }

  // --- 5. VERIFY writer：正しいJWT（aud=logInteractionV2Verify）でPRODとは別コレクションへ書き込まれる ---
  let verifyVisitId;
  {
    const { token } = signVerifyJwt(VERIFY_SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
    verifyVisitId = 'v2e2everify_' + randomSuffix() + '0000000000';
    const eventId = 'e2e_verify_ok_' + randomSuffix();
    const res = await request('logInteractionV2Verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        schemaVersion: 2, event_id: eventId, visit_id: verifyVisitId, occurredAt: Date.now(), eventType: 'page_view',
        visitMediaCode: 'area_check_v1', visitWebSource: 'direct', visitorId: 'vidverify_' + randomSuffix() + '0000000000', visitorIdPersisted: true
      })
    });
    const body = await res.json();
    ok('logInteractionV2Verify: 正しいJWTは200', res.status === 200 && body.success === true, JSON.stringify(body));

    const verifySession = (await db.collection('visit_sessions_verify').doc(verifyVisitId).get()).data();
    ok('logInteractionV2Verify: visit_sessions_verify（VERIFY専用コレクション）へ書き込まれる', !!verifySession && verifySession.mediaCode === 'area_check_v1', JSON.stringify(verifySession));

    const prodSession = await db.collection('visit_sessions').doc(verifyVisitId).get();
    ok('logInteractionV2Verify: PROD側visit_sessionsには一切書き込まれない（完全分離）', !prodSession.exists);

    const verifyRawLog = (await db.collection('interaction_logs_verify').doc(eventId).get()).data();
    const prodRawLogForVerifyEvent = await db.collection('interaction_logs').doc(eventId).get();
    ok('logInteractionV2Verify: interaction_logs_verifyへ書き込まれ、PROD側interaction_logsには存在しない', !!verifyRawLog && !prodRawLogForVerifyEvent.exists);
  }

  // --- 5b. VERIFY writer：aud不一致（正式名でないaud）は401（正本仕様：正式名logInteractionV2Verify・audも同名） ---
  {
    const { token: wrongAud } = signVerifyJwt(VERIFY_SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionVerify', scope: 'write:interaction_logs_v2_verify' });
    const res = await request('logInteractionV2Verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wrongAud}` },
      body: JSON.stringify({ schemaVersion: 2, event_id: 'e2e_verify_wrongaud_' + randomSuffix(), visit_id: visitId, occurredAt: Date.now(), eventType: 'page_view' })
    });
    ok('logInteractionV2Verify: audが旧名"logInteractionVerify"（正式名でない）だと401', res.status === 401, 'status=' + res.status);
  }

  // --- 6. VERIFY writer：偽造JWT（別Secretで署名）は401・PROD/VERIFYどちらにも書き込まれない ---
  {
    const { token: forged } = signVerifyJwt('a-completely-different-secret-not-the-real-one', { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });
    const eventId = 'e2e_verify_forged_' + randomSuffix();
    const res = await request('logInteractionV2Verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${forged}` },
      body: JSON.stringify({ schemaVersion: 2, event_id: eventId, visit_id: visitId, occurredAt: Date.now(), eventType: 'page_view' })
    });
    ok('logInteractionV2Verify: 偽造JWT（別Secret署名）は401', res.status === 401, 'status=' + res.status);
    const verifyRawLog = await db.collection('interaction_logs_verify').doc(eventId).get();
    ok('logInteractionV2Verify: 偽造JWTでは何も書き込まれない', !verifyRawLog.exists);
  }

  // --- 6b. 単位6：isTest訪問はV2の全readerから除外される ---
  let testVisitId;
  {
    testVisitId = 'v2e2e_test_' + randomSuffix() + '0000000000';
    const eventId = 'e2e_istest_' + randomSuffix();
    const token = process.env.FUNNEL_DASHBOARD_TOKEN;
    const res = await request('logInteractionV2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://aoki-tosou.net', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        schemaVersion: 2, event_id: eventId, visit_id: testVisitId, occurredAt: Date.now(), eventType: 'page_view',
        visitMediaCode: 'meishi', visitWebSource: 'direct', visitorId: 'vidtest_' + randomSuffix() + '0000000000', visitorIdPersisted: true,
        testRequested: true
      })
    });
    const body = await res.json();
    ok('logInteractionV2: testRequested=true＋正しいトークンでisTest=trueとして記録される', res.status === 200 && body.success === true, JSON.stringify(body));
    const session = (await db.collection('visit_sessions').doc(testVisitId).get()).data();
    ok('logInteractionV2: isTest=trueがvisit_sessionsに保持される', !!session && session.isTest === true, JSON.stringify(session));
  }

  // --- 7. PROD V2 reader（getFunnelInsightsV2）：トークンなしは401 ---
  {
    const res = await request('getFunnelInsightsV2', { method: 'GET' });
    ok('getFunnelInsightsV2: トークンなしは401', res.status === 401, 'status=' + res.status);
  }

  // --- 8. PROD V2 reader：正しいトークンで、直前に書いたvisit_sessionsを反映した5区分が返る ---
  {
    const res = await request('getFunnelInsightsV2', {
      method: 'GET', headers: { Authorization: `Bearer ${process.env.FUNNEL_DASHBOARD_TOKEN}` }
    });
    const body = await res.json();
    ok('getFunnelInsightsV2: 正しいトークンで200', res.status === 200, JSON.stringify(body).slice(0, 300));
    ok('getFunnelInsightsV2: leadScoreBreakdownに5区分（高/中/低/判定不能/旧ログ）が存在する',
      body.leadScoreBreakdown && ['高', '中', '低', '判定不能', '旧ログ'].every((k) => typeof body.leadScoreBreakdown[k] === 'number'),
      JSON.stringify(body.leadScoreBreakdown));
    const ourCard = (body.leadScoreCards || []).find((c) => c.mediaCode === 'meishi');
    ok('getFunnelInsightsV2: 手順2で書いたPROD側の訪問がleadScoreCardsへ反映される（hashReliable=trueなのでカード化）', !!ourCard, JSON.stringify(body.leadScoreCards));
    const verifyLeak = (body.leadScoreCards || []).find((c) => c.mediaCode === 'area_check_v1');
    ok('getFunnelInsightsV2: VERIFY側の訪問（area_check_v1）はPROD readerへ一切混入しない', !verifyLeak);
    const testLeak = (body.leadScoreCards || []).find((c) => c.visitId === testVisitId);
    ok('getFunnelInsightsV2: isTest=trueの訪問（手順6b）はleadScoreCardsに混入しない', !testLeak);
  }

  // --- 8b. VERIFY reader（getFunnelInsightsV2Verify）：手順5のVERIFY訪問だけが見え、PROD訪問は混入しない ---
  {
    const { token } = signVerifyJwt(VERIFY_SECRET, { sub: 'info@aoki-tosou.net', aud: 'getFunnelInsightsV2Verify', scope: 'write:interaction_logs_v2_verify' });
    const res = await request('getFunnelInsightsV2Verify', { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    ok('getFunnelInsightsV2Verify: 正しいJWTで200', res.status === 200, JSON.stringify(body).slice(0, 300));
    const verifyCard = (body.leadScoreCards || []).find((c) => c.mediaCode === 'area_check_v1');
    ok('getFunnelInsightsV2Verify: 手順5で書いたVERIFY側の訪問が見える', !!verifyCard, JSON.stringify(body.leadScoreCards));
    const prodLeak = (body.leadScoreCards || []).find((c) => c.mediaCode === 'meishi');
    ok('getFunnelInsightsV2Verify: PROD側の訪問（meishi）はVERIFY readerへ一切混入しない', !prodLeak);
  }

  // --- 9. PROD V2版ドリルダウン（getFunnelDrilldownV2）：visit_sessions正本へjoinした結果を返す ---
  {
    const token = process.env.FUNNEL_DASHBOARD_TOKEN;
    const res = await request('getFunnelDrilldownV2?period=thisMonth&metric=visitors', { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    ok('getFunnelDrilldownV2: metric=visitorsで200', res.status === 200, JSON.stringify(body).slice(0, 200));
    const ourVisit = (body.items || []).find((v) => v.mediaCode === 'meishi');
    ok('getFunnelDrilldownV2: 手順2の訪問がvisitors一覧に含まれる', !!ourVisit, JSON.stringify(body.items || []).slice(0, 300));
    const testLeak = (body.items || []).find((v) => v.visitId === testVisitId);
    ok('getFunnelDrilldownV2: isTest=trueの訪問（手順6b）は混入しない', !testLeak);
  }

  // --- 10. PROD V2版直近アクティビティ（getFunnelRecentActivityV2） ---
  {
    const token = process.env.FUNNEL_DASHBOARD_TOKEN;
    const res = await request('getFunnelRecentActivityV2', { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    ok('getFunnelRecentActivityV2: 正しいトークンで200・ok:true', res.status === 200 && body.ok === true, JSON.stringify(body));
    ok('getFunnelRecentActivityV2: newVisitsが1件以上（このテストで書いた訪問を反映）', Number(body.newVisits) >= 1, JSON.stringify(body));
  }

  // --- 11. VERIFY版の読み取り3エンドポイントも認可なしは401（配線の存在確認を兼ねる） ---
  {
    const r1 = await request('getFunnelDrilldownV2Verify?period=thisMonth&metric=visitors', { method: 'GET' });
    ok('getFunnelDrilldownV2Verify: JWTなしは401', r1.status === 401, 'status=' + r1.status);
    const r2 = await request('getFunnelRecentActivityV2Verify', { method: 'GET' });
    ok('getFunnelRecentActivityV2Verify: JWTなしは401', r2.status === 401, 'status=' + r2.status);
  }

  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? ' :: ' + r.detail : '')));
  console.log('TOTAL ' + results.length + ' PASS ' + (results.length - failed.length) + ' FAIL ' + failed.length);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => { console.error('V2_E2E_FATAL_ERROR', err); process.exitCode = 1; });
