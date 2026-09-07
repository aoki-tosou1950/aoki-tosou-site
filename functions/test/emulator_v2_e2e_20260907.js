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
const vm = require('vm');
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
  console.error('VERIFY_JWT_SECRET未設定（functions/.secret.localが読み込まれていない）。中止。');
  process.exit(1);
}
// 監査差し戻し（独立監査再提出R6）#4：読み取り専用Verify3系はVERIFY_JWT_SECRETを
// 一切使わず、専用のVERIFY_READ_TOKENで認可する（.secret.local参照）。
const VERIFY_READ_TOKEN = process.env.VERIFY_READ_TOKEN;
if (!VERIFY_READ_TOKEN) {
  console.error('VERIFY_READ_TOKEN未設定（functions/.secret.localが読み込まれていない）。中止。');
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
  // 監査差し戻し（独立監査再提出R6）#4：読み取り専用Verify3系はVERIFY_JWT_SECRETで
  // 署名したJWTではなく、専用のVERIFY_READ_TOKEN（固定Bearerトークン）で認可する。
  {
    const res = await request('getFunnelInsightsV2Verify', { method: 'GET', headers: { Authorization: `Bearer ${VERIFY_READ_TOKEN}` } });
    const body = await res.json();
    ok('getFunnelInsightsV2Verify: 正しいVERIFY_READ_TOKENで200', res.status === 200, JSON.stringify(body).slice(0, 300));
    const verifyCard = (body.leadScoreCards || []).find((c) => c.mediaCode === 'area_check_v1');
    ok('getFunnelInsightsV2Verify: 手順5で書いたVERIFY側の訪問が見える', !!verifyCard, JSON.stringify(body.leadScoreCards));
    const prodLeak = (body.leadScoreCards || []).find((c) => c.mediaCode === 'meishi');
    ok('getFunnelInsightsV2Verify: PROD側の訪問（meishi）はVERIFY readerへ一切混入しない', !prodLeak);

    // 監査差し戻しR6#4の核心：書き込み専用のVERIFY_JWT_SECRETで正しく署名したJWTを
    // 渡しても、読み取り系は一切JWTを検証しないため認可されない（401）ことを確認する。
    const { token: writerJwt } = signVerifyJwt(VERIFY_SECRET, { sub: 'info@aoki-tosou.net', aud: 'getFunnelInsightsV2Verify', scope: 'write:interaction_logs_v2_verify' });
    const jwtRes = await request('getFunnelInsightsV2Verify', { method: 'GET', headers: { Authorization: `Bearer ${writerJwt}` } });
    ok('getFunnelInsightsV2Verify: 書き込み専用VERIFY_JWT_SECRETで署名した正しいJWTでも401（読み取り系は署名鍵を一切使わない）', jwtRes.status === 401, 'status=' + jwtRes.status);
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
    // 監査差し戻し（独立監査再提出R6）#10：revisitImprovedは実装済みの数値、
    // lineFollowIncreaseはnull＋除外理由（黙って省略しない・0で誤魔化さない）で返る。
    ok('getFunnelRecentActivityV2（finding#10）: revisitImprovedが数値として返る（未実装ではなく実装済み）', typeof body.revisitImproved === 'number', JSON.stringify(body));
    ok('getFunnelRecentActivityV2（finding#10）: lineFollowIncreaseはnull（スコープ除外を明示。0で偽装しない）', body.lineFollowIncrease === null, JSON.stringify(body));
    ok('getFunnelRecentActivityV2（finding#10）: lineFollowIncreaseExcludedReasonで除外理由が文字列として明示される', typeof body.lineFollowIncreaseExcludedReason === 'string' && body.lineFollowIncreaseExcludedReason.length > 0, JSON.stringify(body));
  }

  // --- 11. VERIFY版の読み取り3エンドポイントも認可なしは401、正しいVERIFY_READ_TOKENなら
  // 認可を通過する（配線の存在確認を兼ねる。監査差し戻しR6#4：VERIFY_JWT_SECRETではなく
  // VERIFY_READ_TOKEN） ---
  {
    const r1 = await request('getFunnelDrilldownV2Verify?period=thisMonth&metric=visitors', { method: 'GET' });
    ok('getFunnelDrilldownV2Verify: トークンなしは401', r1.status === 401, 'status=' + r1.status);
    const r1ok = await request('getFunnelDrilldownV2Verify?period=thisMonth&metric=visitors', { method: 'GET', headers: { Authorization: `Bearer ${VERIFY_READ_TOKEN}` } });
    ok('getFunnelDrilldownV2Verify: 正しいVERIFY_READ_TOKENで200', r1ok.status === 200, 'status=' + r1ok.status);

    const r2 = await request('getFunnelRecentActivityV2Verify', { method: 'GET' });
    ok('getFunnelRecentActivityV2Verify: トークンなしは401', r2.status === 401, 'status=' + r2.status);
    const r2ok = await request('getFunnelRecentActivityV2Verify', { method: 'GET', headers: { Authorization: `Bearer ${VERIFY_READ_TOKEN}` } });
    ok('getFunnelRecentActivityV2Verify: 正しいVERIFY_READ_TOKENで200', r2ok.status === 200, 'status=' + r2ok.status);
  }

  // --- 12. 監査差し戻し（独立監査再提出R6）#1・#2：occurred_atを持たないV1形状の
  // raw log（logInteractionが実際に書く形状そのもの＝created_atのみ・visit_id無し）を
  // 実Firestoreへ直接書き込み、legacy集計（旧ログ／判定不能）へ正しく反映されることを
  // 確認する。#2も合わせて確認：同日・hash空のpage_view行2件は判定不能へ+2で
  // 反映される（+1へ潰れない）こと。 ---
  {
    const before = await (await request('getFunnelInsightsV2', {
      method: 'GET', headers: { Authorization: `Bearer ${process.env.FUNNEL_DASHBOARD_TOKEN}` }
    })).json();

    const legacyHashPresentId = 'e2e_v1legacy_hash_' + randomSuffix();
    const legacyHashMissingId1 = 'e2e_v1legacy_nohash1_' + randomSuffix();
    const legacyHashMissingId2 = 'e2e_v1legacy_nohash2_' + randomSuffix();
    // V1のlogInteractionハンドラ（functions/index.js）が実際にinteraction_logsへ書く
    // フィールド集合そのもの：occurred_atフィールドは一切存在しない（created_atのみ、
    // FieldValue.serverTimestamp()相当）。visit_idフィールドも一切存在しない。
    await db.collection('interaction_logs').doc(legacyHashPresentId).set({
      event_type: 'page_view', contact_channel: '', source: 'other', from: '',
      landing_page: '/', current_page: '/', referrer: '', is_test: false,
      visitor_hash: 'e2e_v1_hash_' + randomSuffix(),
      created_at: new Date()
    });
    await db.collection('interaction_logs').doc(legacyHashMissingId1).set({
      event_type: 'page_view', contact_channel: '', source: 'other', from: '',
      landing_page: '/', current_page: '/', referrer: '', is_test: false,
      visitor_hash: '',
      created_at: new Date()
    });
    await db.collection('interaction_logs').doc(legacyHashMissingId2).set({
      event_type: 'page_view', contact_channel: '', source: 'other', from: '',
      landing_page: '/', current_page: '/', referrer: '', is_test: false,
      visitor_hash: '',
      created_at: new Date()
    });

    const after = await (await request('getFunnelInsightsV2', {
      method: 'GET', headers: { Authorization: `Bearer ${process.env.FUNNEL_DASHBOARD_TOKEN}` }
    })).json();

    ok('getFunnelInsightsV2（finding#1）: occurred_atを持たないV1形状のraw log（hash有り）が旧ログへ+1反映される',
      after.leadScoreBreakdown.旧ログ === before.leadScoreBreakdown.旧ログ + 1,
      `before=${before.leadScoreBreakdown.旧ログ} after=${after.leadScoreBreakdown.旧ログ}`);
    ok('getFunnelInsightsV2（finding#1・#2）: occurred_atを持たないV1形状のraw log（hash無し）2件が判定不能へ+2反映される（+1へ潰れない）',
      after.leadScoreBreakdown.判定不能 === before.leadScoreBreakdown.判定不能 + 2,
      `before=${before.leadScoreBreakdown.判定不能} after=${after.leadScoreBreakdown.判定不能}`);
  }

  // --- 13. 訂正（独立監査再提出R7・項目4）：R6時点は「legacyを除外してlegacyAttribution
  // Scopeへ書くだけ」の設計だったが、これはV2 reader後方互換契約を満たさないという
  // 指摘を受け、legacyを実際にV2と同じ集計パイプラインへ合流させた。同一期間へV1実形状
  // （legacy）とV2実形状（新方式）を両方投入し、mediaQuality・drilldownの両方で
  // legacyが実際に反映される（除外されない）ことを実データで確認する。 ---
  {
    const beforeInsights = await (await request('getFunnelInsightsV2', {
      method: 'GET', headers: { Authorization: `Bearer ${process.env.FUNNEL_DASHBOARD_TOKEN}` }
    })).json();
    const beforeMeishi = (beforeInsights.mediaQuality || []).find((m) => m.mediaCode === 'meishi');
    const beforeMeishiVisits = beforeMeishi ? Number(beforeMeishi.visits || 0) : 0;

    // V1実形状（legacy）：mediaCode='meishi'相当のfromを持つが、visit_idもoccurred_atも
    // 持たない（手順12と同じ実形状）。R7・項目4：これが実際にmediaQualityの'meishi'
    // 集計へ合流する（visits件数が増える）ことを確認する。
    const legacyMarkerId = 'e2e_r7legacy_' + randomSuffix();
    await db.collection('interaction_logs').doc(legacyMarkerId).set({
      event_type: 'page_view', contact_channel: '', source: 'other', from: 'meishi',
      landing_page: '/', current_page: '/', referrer: '', is_test: false,
      visitor_hash: 'e2e_r7_legacyhash_' + randomSuffix(),
      created_at: new Date()
    });

    const afterLegacyOnly = await (await request('getFunnelInsightsV2', {
      method: 'GET', headers: { Authorization: `Bearer ${process.env.FUNNEL_DASHBOARD_TOKEN}` }
    })).json();
    const afterLegacyMeishi = (afterLegacyOnly.mediaQuality || []).find((m) => m.mediaCode === 'meishi');
    const afterLegacyMeishiVisits = afterLegacyMeishi ? Number(afterLegacyMeishi.visits || 0) : 0;
    ok('getFunnelInsightsV2（R7#4）: legacy（V1実形状・from=meishi）を追加するとmediaQualityの"meishi"visits件数が+1される（真に合流している。R6時点は「変化しない」ことを期待していたが、これは指摘どおり誤りだった仕様）',
      afterLegacyMeishiVisits === beforeMeishiVisits + 1,
      `before=${beforeMeishiVisits} afterLegacyOnly=${afterLegacyMeishiVisits}`);

    // V2実形状（新方式）：同じmediaCode='meishi'の実visitを実エンドポイント経由で追加する。
    // legacyとV2が同じ媒体キーの下で合算されることを確認する（対照実験）。
    const v2VisitId = 'v2e2e_r7marker_' + randomSuffix() + '0000000000';
    const v2EventId = 'e2e_r7marker_' + randomSuffix();
    const v2Res = await request('logInteractionV2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://aoki-tosou.net' },
      body: JSON.stringify({
        schemaVersion: 2, event_id: v2EventId, visit_id: v2VisitId, occurredAt: Date.now(), eventType: 'page_view',
        visitMediaCode: 'meishi', visitWebSource: '', visitorId: 'vid2e2e_r7marker_' + randomSuffix() + '0000000000', visitorIdPersisted: true,
        currentPage: 'https://aoki-tosou.net/', landingPage: 'https://aoki-tosou.net/'
      })
    });
    const v2Body = await v2Res.json();
    ok('logInteractionV2（R7#4用マーカー訪問）: 正常page_viewは200', v2Res.status === 200 && v2Body.success === true, JSON.stringify(v2Body));

    const afterBoth = await (await request('getFunnelInsightsV2', {
      method: 'GET', headers: { Authorization: `Bearer ${process.env.FUNNEL_DASHBOARD_TOKEN}` }
    })).json();
    const afterBothMeishi = (afterBoth.mediaQuality || []).find((m) => m.mediaCode === 'meishi');
    const afterBothMeishiVisits = afterBothMeishi ? Number(afterBothMeishi.visits || 0) : 0;
    ok('getFunnelInsightsV2（R7#4）: V2実形状（新方式）の同一mediaCode訪問を追加すると、legacyの分と合わせてmediaQualityの"meishi"visitsがさらに+1される（件数包含関係：legacy分+V2分が両方合算される）',
      afterBothMeishiVisits === beforeMeishiVisits + 2,
      `before=${beforeMeishiVisits} afterLegacyOnly=${afterLegacyMeishiVisits} afterBoth=${afterBothMeishiVisits}`);

    ok('getFunnelInsightsV2（R7#4）: 応答のlegacyAttributionScopeが「除外」ではなく「実際にどう合流しているか」を説明する新shape（legacyIncludedInにmediaQualityを含む）になっている',
      !!afterBoth.legacyAttributionScope &&
      Array.isArray(afterBoth.legacyAttributionScope.legacyIncludedIn) && afterBoth.legacyAttributionScope.legacyIncludedIn.includes('mediaQuality') &&
      afterBoth.legacyAttributionScope.excludedFrom === undefined,
      JSON.stringify(afterBoth.legacyAttributionScope));

    // getFunnelDrilldownV2（metric=visitors）でも、legacy疑似訪問（visitIdが"legacy:"で
    // 始まる）とV2実訪問の両方が一覧に含まれることを確認する（R7・項目4）。
    const drilldownRes = await request('getFunnelDrilldownV2?period=thisMonth&metric=visitors', {
      method: 'GET', headers: { Authorization: `Bearer ${process.env.FUNNEL_DASHBOARD_TOKEN}` }
    });
    const drilldownBody = await drilldownRes.json();
    ok('getFunnelDrilldownV2（R7#4）: 応答のlegacyAttributionScopeも新shape（legacyIncludedInにdrilldown(metric=visitors)を含む）',
      !!drilldownBody.legacyAttributionScope && Array.isArray(drilldownBody.legacyAttributionScope.legacyIncludedIn) && drilldownBody.legacyAttributionScope.legacyIncludedIn.some((s) => s.indexOf('visitors') >= 0),
      JSON.stringify(drilldownBody.legacyAttributionScope));
    const v2MarkerInDrilldown = (drilldownBody.items || []).find((v) => v.visitId === v2VisitId);
    ok('getFunnelDrilldownV2（R7#4）: V2実形状のマーカー訪問はvisitors一覧に含まれる',
      !!v2MarkerInDrilldown, JSON.stringify((drilldownBody.items || []).slice(0, 3)));
    const legacyItemsInDrilldown = (drilldownBody.items || []).filter((v) => String(v.visitId || '').indexOf('legacy:') === 0 && v.mediaCode === 'meishi');
    ok('getFunnelDrilldownV2（R7#4）: legacy疑似訪問（visitIdが"legacy:"で始まる）もvisitors一覧に含まれる（合流していることの直接確認）',
      legacyItemsInDrilldown.length >= 1, JSON.stringify(legacyItemsInDrilldown.slice(0, 3)));

    // Web反応一覧（metric=lineClicks）でもlegacyのreaction-onlyアイテムが個別に（訪問へ
    // 推測結合せず）含まれることを確認する。
    const legacyReactionMarkerId = 'e2e_r7legacy_reaction_' + randomSuffix();
    await db.collection('interaction_logs').doc(legacyReactionMarkerId).set({
      event_type: 'line_click', contact_channel: 'LINE', source: 'other', from: 'meishi',
      landing_page: '/', current_page: '/', referrer: '', is_test: false,
      visitor_hash: 'e2e_r7_legacyreactionhash_' + randomSuffix(),
      created_at: new Date()
    });
    const lineClicksDrilldownRes = await request('getFunnelDrilldownV2?period=thisMonth&metric=lineClicks', {
      method: 'GET', headers: { Authorization: `Bearer ${process.env.FUNNEL_DASHBOARD_TOKEN}` }
    });
    const lineClicksDrilldownBody = await lineClicksDrilldownRes.json();
    const legacyReactionItems = (lineClicksDrilldownBody.items || []).filter((v) => String(v.visitId || '').indexOf('legacy:reaction:') === 0 && v.mediaCode === 'meishi');
    ok('getFunnelDrilldownV2（R7#4・metric=lineClicks）: legacyのreaction行は訪問へ推測結合されず、visitIdが"legacy:reaction:"で始まる個別itemとして含まれる（visitPageViewCountはnull＝不明のまま捏造しない）',
      legacyReactionItems.length >= 1 && legacyReactionItems.every((it) => it.visitPageViewCount === null), JSON.stringify(legacyReactionItems.slice(0, 3)));
  }

  // --- 14. 独立監査再提出（R7）・項目6：「検証用analytics → logInteractionV2Verify →
  // VERIFY隔離collection → V2 Verify readers」の一気通貫を、手作りpayloadではなく
  // 実際のjs/analytics-v2.js（PROD向け・完全無改変の実クライアント本体）が生成した
  // payloadで確認する。
  //
  // 設計判断（重要・明記）：js/analytics-v2.jsはPROD専用エンドポイント（ENDPOINT定数）へ
  // 無認可・CORS前提のfetch/sendBeaconで送る単一の本番スクリプトであり、VERIFY専用の
  // Authorization: Bearer JWT認可はこのスクリプトの責務外（JWTという概念を一切知らない）。
  // 「検証用analytics」を実現するために訪問境界・payload生成ロジック（getOrUpdateVisit／
  // buildEvent等）を別ファイルへ複製・再実装すると、指摘が禁止する「同じロジックの
  // 再実装によるspec drift」を新たに生んでしまう。そのため本テストでは、vm上で
  // js/analytics-v2.jsを一切書き換えず実行し、スクリプトが実際に呼び出す
  // window.fetch(ENDPOINT, init)の「init（実クライアントが生成した実payload・
  // Content-Type・keepalive:true）」だけを横取りし、送信先URLとAuthorizationヘッダーだけを
  // VERIFY用に差し替えて実Emulatorへ実際にHTTP POSTする。訪問境界・payload生成コードは
  // 1行も複製・変更していない。JWTはこのテスト内でのみ動的署名・メモリ保持し、
  // capturedRequestsやok()のdetailへは一切含めない（commits/logs/URLへ漏れない設計）。
  // sendBeaconはこの経路で一切呼ばれないことも確認する（VERIFY用にはfetch+Bearer+
  // keepaliveのみを使う、という確定契約どおり）。
  {
    const analyticsScript = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'analytics-v2.js'), 'utf8');
    const { token: clientVerifyToken } = signVerifyJwt(VERIFY_SECRET, { sub: 'info@aoki-tosou.net', aud: 'logInteractionV2Verify', scope: 'write:interaction_logs_v2_verify' });

    const capturedRequests = [];
    let beaconCallCount = 0;
    let settleResolve;
    const settled = new Promise((resolve) => { settleResolve = resolve; });

    const localStore = new Map();
    const sessionStore = new Map();
    const pageUrl = 'https://aoki-tosou.net/?from=' + ('area_check_verify_v1_' + randomSuffix());
    const mediaCodeExpected = new URL(pageUrl).searchParams.get('from');
    const location = new URL(pageUrl);
    const document = {
      referrer: 'https://www.google.com/search?q=aoki',
      visibilityState: 'visible',
      addEventListener() {},
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
      crypto: { randomUUID: () => 'e2everifyclient' + randomSuffix() + randomSuffix() },
      // ここがこのテストの核心：endpoint／initはanalytics-v2.js自身が生成した実引数のまま。
      // 送信先とAuthorizationヘッダーだけをVERIFY向けへ実際に差し替えて実Emulatorへ送る
      // （payload本体＝init.bodyは一切書き換えない・複製しない）。
      fetch(endpoint, init) {
        const verifyUrl = `${base}/logInteractionV2Verify`;
        const req = fetch(verifyUrl, {
          method: init.method,
          headers: Object.assign({}, init.headers, { Authorization: `Bearer ${clientVerifyToken}` }),
          body: init.body,
          keepalive: init.keepalive
        });
        req.then((res) => { capturedRequests.push({ endpoint, verifyUrl, init, status: res.status }); settleResolve(); })
          .catch((err) => { capturedRequests.push({ endpoint, verifyUrl, init, error: String(err && err.message || err) }); settleResolve(); });
        return req;
      },
      addEventListener() {},
      document
    };
    const context = {
      URL, URLSearchParams,
      Blob: class { constructor(parts, options) { this.text = parts.join(''); this.type = (options && options.type) || ''; } },
      Date, Math, JSON, Promise, console,
      window: windowObj, document,
      navigator: { sendBeacon() { beaconCallCount++; return true; } }
    };
    windowObj.document = document;
    windowObj.navigator = context.navigator;
    vm.runInNewContext(analyticsScript, context);

    await settled;
    await new Promise((resolve) => setImmediate(resolve)); // analytics-v2.js自身の.then()（removeFromOutbox等）にもう1tick譲る

    ok('R7#6 検証用analytics: 実クライアント（js/analytics-v2.js・無改変）のinit()が自動的にtrack("page_view")で1回だけfetchを呼ぶ', capturedRequests.length === 1, JSON.stringify(capturedRequests.map((r) => ({ status: r.status, error: r.error }))));
    const captured = capturedRequests[0] || {};
    ok('R7#6 検証用analytics: そのfetch呼び出しをVERIFY writer（logInteractionV2Verify）へ実際にHTTP転送し200が返る', captured.status === 200, JSON.stringify({ status: captured.status, error: captured.error }));
    ok('R7#6 検証用analytics: init.keepalive===trueが維持される（PROD同様の確定契約・別実装を作っていない証拠）', !!(captured.init && captured.init.keepalive === true));
    ok('R7#6 検証用analytics: sendBeaconはVERIFY経路で一度も呼ばれない（fetch+Bearer+keepaliveのみを使う確定契約）', beaconCallCount === 0, 'beaconCallCount=' + beaconCallCount);

    const sentBody = captured.init ? JSON.parse(captured.init.body) : {};
    ok('R7#6 検証用analytics: 実クライアントが生成したpayloadはschemaVersion:2（ハンドクラフトしていない実クライアント出力）', sentBody.schemaVersion === 2);
    ok('R7#6 検証用analytics: 実クライアントの訪問境界ロジック（rawAttributionFromSignal）がURLのfromパラメータをvisitMediaCodeへそのまま反映', sentBody.visitMediaCode === mediaCodeExpected, `expected=${mediaCodeExpected} actual=${sentBody.visitMediaCode}`);
    ok('R7#6 検証用analytics: 外部referrer（google.com）が実クライアントのロジックでvisitWebSourceへ反映される（PRODと同一コード）', sentBody.visitWebSource === 'www.google.com', 'actual=' + sentBody.visitWebSource);

    const verifySession = sentBody.visit_id ? (await db.collection('visit_sessions_verify').doc(sentBody.visit_id).get()).data() : null;
    ok('R7#6 検証用analytics: 実クライアント生成のvisit_idでvisit_sessions_verify（VERIFY隔離collection）へ実際に書き込まれる', !!verifySession && verifySession.mediaCode === mediaCodeExpected, JSON.stringify(verifySession));

    const verifyReaderRes = await request('getFunnelInsightsV2Verify', { method: 'GET', headers: { Authorization: `Bearer ${VERIFY_READ_TOKEN}` } });
    const verifyReaderBody = await verifyReaderRes.json();
    const verifyCard = (verifyReaderBody.leadScoreCards || []).find((c) => c.mediaCode === mediaCodeExpected);
    ok('R7#6 検証用analytics: V2 Verify reader（getFunnelInsightsV2Verify）が実クライアント生成の訪問を反映する（一気通貫の最終確認）', !!verifyCard, JSON.stringify((verifyReaderBody.leadScoreCards || []).slice(0, 5)));
  }

  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? ' :: ' + r.detail : '')));
  console.log('TOTAL ' + results.length + ' PASS ' + (results.length - failed.length) + ' FAIL ' + failed.length);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => { console.error('V2_E2E_FATAL_ERROR', err); process.exitCode = 1; });
