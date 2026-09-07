'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  authorizeBearer,
  createFunnelStore,
  dashboardPayload,
  funnelDrilldown,
  funnelInsights,
  funnelRecentActivity,
  isAuthorizedTestEvent,
  jstDateKey,
  normalizeEvent,
  normalizeSalesDays,
  periodBounds,
  shiftDateKey,
  verifyLineSignature,
  visitorToken
} = require('./lib/funnel');
const { sendAdminLinePush } = require('./lib/line');
const {
  validateCoreFields: validateCoreFieldsV2,
  normalizeMediaCode,
  normalizeWebSource,
  evaluateVisitorIdentity,
  recordWebEventV2,
  classifyLogCategory,
  buildQualityAxes,
  buildLeadScoreBreakdownV2,
  verifyVerifyJwt
} = require('./lib/funnelV2');

initializeApp();
const db = getFirestore();
const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const { recordInternalMetric, recordLineEvent, recordWebEvent } = createFunnelStore(db);

/* ============================================================================
 * 単位EF：schemaVersion:2 配線（2026-09-07追加）
 *
 * predeploy検査（scripts/predeploy_check_dataenv.js）が関数名とdataEnvの対応を機械検査
 * できるよう、各V2/VERIFYエンドポイントは以下の規約を守ること：
 *   - PROD V2の関数名は末尾に"V2"を含み、"Verify"は含まない。V2_PROD_COLLECTIONSのみを
 *     参照し、secrets配列にVERIFY_JWT_SECRETを含めない。
 *   - VERIFYの関数名は"Verify"を含む。V2_VERIFY_COLLECTIONSのみを参照し、
 *     secrets配列に必ずVERIFY_JWT_SECRETを含める。
 * この規約自体はコード上のコメントだけでなく、predeploy_check_dataenv.jsが関数本体の
 * ソーステキストを直接静的解析して機械的に確認する（人間のレビュー漏れに依存しない）。
 * ============================================================================ */

// PRODは既存V1と同じコレクション名を共有する（interaction_logs／funnel_dailyは
// V1のfunnelDrilldown/funnelInsightsが読む既存コレクションそのもの。classifyLogCategory
// が「legacy（V1由来・visit_idなし）」と「new_reliable/new_unreliable（V2由来）」を
// 同一コレクション内のフィールド有無で区別する設計のため、意図的に分離しない。
// visit_sessionsはV2が新設する専用コレクション）。
const V2_PROD_COLLECTIONS = Object.freeze({
  interactionLogs: 'interaction_logs',
  funnelDaily: 'funnel_daily',
  visitSessions: 'visit_sessions'
});

// VERIFYはPRODと完全分離した専用コレクション（正本仕様：VERIFYコレクションとPROD
// コレクションを完全分離）。本番の実データには一切触れない。
const V2_VERIFY_COLLECTIONS = Object.freeze({
  interactionLogs: 'interaction_logs_verify',
  funnelDaily: 'funnel_daily_verify',
  visitSessions: 'visit_sessions_verify'
});

const V2_MAX_BODY_BYTES = 8192; // request size制限：通常のトラッキングpayloadに対し十分大きく、異常payloadは拒否する

/**
 * schemaVersion:2の生payloadを検証・正規化し、recordWebEventV2へ渡せるevent
 * オブジェクトを組み立てる（PROD/VERIFY共通）。クライアント側では一切正規化・検証を
 * 行わない設計（クライアントは生値を送るだけ。信頼できるのは常にサーバー側の判定のみ）。
 */
function buildV2Event(body, headers, dashboardToken) {
  if (!isPlainObjectV2(body)) return { ok: false, status: 400, error: 'Invalid JSON body' };
  const core = validateCoreFieldsV2(body, new Date());
  if (!core.ok) return { ok: false, status: 400, error: core.error };

  const mediaResult = normalizeMediaCode(body.visitMediaCode);
  const webSourceResult = normalizeWebSource(body.visitWebSource);
  const identity = evaluateVisitorIdentity(body.visitorId, body.visitorIdPersisted);
  const isTest = isAuthorizedTestEvent(body.testRequested, headers.authorization, dashboardToken);

  const event = Object.assign({}, core.core, {
    mediaCode: mediaResult.mediaCode,
    mediaValidity: mediaResult.mediaValidity,
    invalidMediaCodeHash: mediaResult.invalidMediaCodeHash,
    webSource: webSourceResult.webSource,
    webSourceStatus: webSourceResult.webSourceStatus,
    invalidWebSourceHash: webSourceResult.invalidWebSourceHash,
    visitorHash: identity.visitorHash,
    hashReliable: identity.hashReliable,
    visitorIdStatus: identity.visitorIdStatus,
    rawVisitorId: typeof body.visitorId === 'string' ? body.visitorId : '',
    contactChannel: optionalString(body.contactChannel, 30),
    currentPage: optionalString(body.currentPage, 500),
    landingPage: optionalString(body.landingPage, 500),
    referrerHost: optionalString(body.referrerHost, 255),
    isTest
  });
  return { ok: true, event };
}

function isPlainObjectV2(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function extractBearerToken(header) {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

async function handleV2Write(req, res, collections, dashboardToken) {
  if (!setCorsHeaders(req, res)) return res.status(403).json({ error: 'Forbidden: Origin not allowed' });
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > V2_MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Payload Too Large' });
  }
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
    return res.status(415).json({ error: 'Content-Type must be application/json or text/plain' });
  }

  let body;
  try {
    body = parseRequestBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > V2_MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Payload Too Large' });
  }

  const built = buildV2Event(body, req.headers, dashboardToken);
  if (!built.ok) return res.status(built.status).json({ error: built.error });

  try {
    const result = await recordWebEventV2(db, collections, built.event, new Date());
    return res.status(200).json({ success: true, aggregate: result });
  } catch (err) {
    console.error('handleV2Write failed:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * PROD V2 writer。既存の`logInteraction`（V1）とは別関数として並行deployする
 * （正本仕様：V2関数をV1と並行deploy）。V1エンドポイントは無変更のまま残す。
 * DATA_ENV: PROD_V2
 */
exports.logInteractionV2 = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => handleV2Write(req, res, V2_PROD_COLLECTIONS, process.env.FUNNEL_DASHBOARD_TOKEN)
);

/**
 * VERIFY writer。専用JWT（HS256・VERIFY_JWT_SECRET）で認可し、PRODとは完全に分離された
 * コレクションへのみ書き込む。本番サイト・本番トラフィックからは一切呼ばれない
 * （検証用スクリプト専用のエンドポイント）。
 * DATA_ENV: VERIFY
 *
 * secrets配列にVERIFY_JWT_SECRETを含める（Secret Managerでの作成・IAMアクセス制限
 * ＝info@aoki-tosou.netと専用service accountのみへの限定は、今回のセッションでは
 * 未実施＝人間の実施が必要。詳細は最終報告を参照）。
 */
exports.logInteractionVerify = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['VERIFY_JWT_SECRET']
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const token = extractBearerToken(req.headers.authorization);
    const verdict = verifyVerifyJwt(token, process.env.VERIFY_JWT_SECRET, {
      expectedAud: 'logInteractionVerify',
      expectedScope: 'write:interaction_logs_v2_verify',
      expectedSub: 'info@aoki-tosou.net'
    });
    if (!verdict.ok) {
      // 監査差し戻し#6：署名不正時などverdict.jtiが無い場合はレスポンスにも一切含めない
      // （verifyVerifyJwt自体が既に保証しているが、ここでも生payloadを追加で出力しない）。
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > V2_MAX_BODY_BYTES) return res.status(413).json({ error: 'Payload Too Large' });
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
      return res.status(415).json({ error: 'Content-Type must be application/json or text/plain' });
    }
    let body;
    try {
      body = parseRequestBody(req);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    if (Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > V2_MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload Too Large' });
    }

    const built = buildV2Event(body, req.headers, undefined); // VERIFYはis_test概念を使わない（常にfalse）
    if (!built.ok) return res.status(built.status).json({ error: built.error });

    try {
      const result = await recordWebEventV2(db, V2_VERIFY_COLLECTIONS, built.event, new Date());
      return res.status(200).json({ success: true, aggregate: result });
    } catch (err) {
      console.error('logInteractionVerify failed:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/**
 * PROD V2 reader：media/webSource独立2軸、見込み度5区分（高・中・低・判定不能・旧ログ）、
 * legacy＋新方式4分類の集計を返す読み取り専用API。既存getFunnelInsights（V1）とは別関数
 * （V1は無変更のまま残す）。
 * DATA_ENV: PROD_V2
 */
exports.getFunnelInsightsV2 = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireDashboardToken(req, res)) return;
    const period = ['thisMonth', 'lastMonth', 'thisWeek'].includes(req.query.period)
      ? req.query.period
      : 'thisMonth';
    const bounds = periodBounds(period, new Date());
    const levelFilter = ['高', '中', '低', '判定不能'].includes(req.query.level) ? req.query.level : null;

    try {
      const startAt = new Date(`${bounds.start}T00:00:00.000+09:00`).getTime();
      const endAt = new Date(`${shiftDateKey(bounds.end, 1)}T00:00:00.000+09:00`).getTime();

      const sessionSnapshot = await db.collection(V2_PROD_COLLECTIONS.visitSessions)
        .where('startedAt', '>=', startAt).where('startedAt', '<', endAt).get();
      const visitSessions = sessionSnapshot.docs.map((doc) => Object.assign({ visitId: doc.id }, doc.data()));

      // legacy件数（visit_idを持たないV1時代のraw log）はinteraction_logsを直接読んで数える。
      // V1のloadInteractionRows_・訪問グルーピングは複製しない（V1無変更の方針）ため、
      // 「訪問単位」ではなく「raw log単位」の件数であることをレスポンスのnoteで明示する。
      const logSnapshot = await db.collection(V2_PROD_COLLECTIONS.interactionLogs)
        .where('occurred_at', '>=', startAt).where('occurred_at', '<', endAt).get();
      let legacyLogCount = 0;
      logSnapshot.forEach((doc) => {
        const data = doc.data();
        if (data.is_test) return;
        if (classifyLogCategory(data) === 'legacy_unknown' || classifyLogCategory(data) === 'legacy_hash_missing') legacyLogCount += 1;
      });

      const { mediaQuality, webSourceQuality } = buildQualityAxes(visitSessions);
      const { counts, cards } = buildLeadScoreBreakdownV2(visitSessions, legacyLogCount);
      const filteredCards = levelFilter ? cards.filter((c) => c.level === levelFilter) : cards;

      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json({
        period: Object.assign({ key: period }, bounds),
        mediaQuality,
        webSourceQuality,
        leadScoreBreakdown: counts,
        leadScoreCards: filteredCards,
        note: '旧ログ（leadScoreBreakdown.旧ログ）は訪問単位ではなくraw log単位の件数です。'
      });
    } catch (error) {
      console.error('getFunnelInsightsV2 failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

const ALLOWED_ORIGINS = [
  'https://aoki-tosou.net',
  'https://www.aoki-tosou.net',
  'https://aokitosou-miniapp.web.app'
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return false;
  }

  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Vary', 'Origin');
  return true;
}

function optionalString(value, maxLength) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLength);
}

function parseRequestBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody.toString('utf8')
    : (typeof req.body === 'string' ? req.body : '');

  if (!rawBody) return {};
  return JSON.parse(rawBody);
}

function requireDashboardToken(req, res) {
  if (!authorizeBearer(req.headers.authorization, process.env.FUNNEL_DASHBOARD_TOKEN)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function getLineInsight() {
  const token = process.env.LINE_ACCESS_TOKEN;
  if (!token) return { available: false, reason: 'LINE_ACCESS_TOKEN未設定' };
  const date = shiftDateKey(jstDateKey(new Date()), -1).replace(/-/g, '');
  try {
    const response = await axios.get(`https://api.line.me/v2/bot/insight/followers?date=${date}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000
    });
    const data = response.data || {};
    if (data.status !== 'ready') return { available: false, date, reason: `LINE統計状態: ${data.status || 'unknown'}` };
    return {
      available: true,
      date,
      followersCumulative: data.followers,
      blocks: data.blocks,
      targetedReaches: data.targetedReaches,
      currentFriends: null,
      currentFriendsReason: 'Messaging APIは正確な現在友だち数を返さないため未表示'
    };
  } catch (error) {
    console.error('getLineInsight failed:', error.response && error.response.status || error.message);
    return { available: false, date, reason: 'LINE統計APIから取得できませんでした' };
  }
}

exports.submitForm = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['LINE_ACCESS_TOKEN', 'ADMIN_LINE_USER_ID', 'FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    // --- CORS チェック ---
    if (!setCorsHeaders(req, res)) {
      return res.status(403).json({ error: 'Forbidden: Origin not allowed' });
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // --- Content-Type チェック ---
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }

    const {
      name,
      address,
      phone,
      message,
      datetime,
      source,
      contact_channel: contactChannel,
      first_seen_at: firstSeenAt,
      landing_page: landingPage,
      referrer
    } = req.body || {};

    // --- 必須フィールドチェック ---
    const missing = [];
    if (!name  || !String(name).trim())    missing.push('name');
    if (!address || !String(address).trim()) missing.push('address');
    if (!phone || !String(phone).trim())   missing.push('phone');
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Required fields are missing or empty: ${missing.join(', ')}`
      });
    }

    const trimmedName    = String(name).trim();
    const trimmedAddress = String(address).trim();
    const trimmedPhone   = String(phone).trim();
    const trimmedMessage = message ? String(message).trim() : '';
    const isTest = isAuthorizedTestEvent(req.body && req.body.test_event, req.headers.authorization, process.env.FUNNEL_DASHBOARD_TOKEN);

    // --- 文字数チェック ---
    if (trimmedName.length > 50) {
      return res.status(400).json({ error: 'name must be 50 characters or less' });
    }
    if (trimmedAddress.length > 200) {
      return res.status(400).json({ error: 'address must be 200 characters or less' });
    }
    if (trimmedMessage.length > 1000) {
      return res.status(400).json({ error: 'message must be 1000 characters or less' });
    }

    // --- 電話番号フォーマット（数字とハイフンのみ）---
    if (!/^[\d-]+$/.test(trimmedPhone)) {
      return res.status(400).json({ error: 'phone must contain only digits and hyphens' });
    }

    try {
      // --- Firestore 保存 ---
      const submissionRef = await db.collection('submissions').add({
        name:      trimmedName,
        address:   trimmedAddress,
        phone:     trimmedPhone,
        message:   trimmedMessage,
        datetime:  optionalString(datetime, 200),
        source: optionalString(source, 100),
        contact_channel: optionalString(contactChannel, 30),
        first_seen_at: optionalString(firstSeenAt, 60),
        landing_page: optionalString(landingPage, 500),
        referrer: optionalString(referrer, 500),
        formType: 'survey',
        test_event: isTest,
        userAgent: optionalString(req.headers['user-agent'], 500),
        createdAt: FieldValue.serverTimestamp()
      });
      try {
        await recordInternalMetric('inquirySubmits', `form_${submissionRef.id}`, source || 'フォーム', new Date(), isTest);
      } catch (metricError) {
        console.error('submitForm: funnel metric failed:', metricError);
      }
    } catch (err) {
      console.error('submitForm: Firestore save failed:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    // --- LINE Messaging API push（管理者のみ。broadcast は使用禁止）---
    // Firestore 保存後に独立して実行。失敗しても送信成功を返す。
    const lineMessage =
      `【お問い合わせ受信】\n` +
      `■ 名前: ${trimmedName}\n` +
      `■ 住所: ${trimmedAddress}\n` +
      `■ 電話: ${trimmedPhone}\n` +
      `■ 日時: ${optionalString(datetime, 200) || 'なし'}\n` +
      `■ メッセージ: ${trimmedMessage || 'なし'}`;
    await sendAdminLinePush(axios, {
      context: 'submitForm',
      token: process.env.LINE_ACCESS_TOKEN,
      to: process.env.ADMIN_LINE_USER_ID,
      messages: [{ type: 'text', text: lineMessage }]
    });

    return res.status(200).json({ success: true, message: 'お問い合わせを受け付けました。' });
  }
);

exports.logInteraction = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    if (!setCorsHeaders(req, res)) {
      return res.status(403).json({ error: 'Forbidden: Origin not allowed' });
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const contentType = req.headers['content-type'] || '';
    const acceptsJson = contentType.includes('application/json');
    const acceptsText = contentType.includes('text/plain');
    if (!acceptsJson && !acceptsText) {
      return res.status(415).json({ error: 'Content-Type must be application/json or text/plain' });
    }

    let body;
    try {
      body = parseRequestBody(req);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    if (!body.event_id) body.event_id = `legacy_${crypto.randomUUID().replace(/-/g, '')}`;
    let event;
    try {
      event = normalizeEvent(body);
      event.isTest = isAuthorizedTestEvent(event.testRequested, req.headers.authorization, process.env.FUNNEL_DASHBOARD_TOKEN);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    try {
      await db.collection('interaction_logs').add({
        event_type: event.eventType,
        contact_channel: event.contactChannel,
        source: event.source,
        // 2026-08-31追加（集客ファネル知性化）：青木塗装が付与した媒体識別（チラシ・QR等の
        // fromコード。既存の媒体コードマスタで管理）を、Web参照元（direct/検索エンジン等）
        // とは独立に保持する。クライアント（js/analytics.js）は元々毎回この値を送信して
        // いたが、これまでサーバー側で保存していなかった（source列が兼用していたため）。
        from: event.from,
        landing_page: event.landingPage,
        current_page: event.currentPage,
        referrer: event.referrer,
        is_test: event.isTest,
        // 2026-08-30追加：ダッシュボードdrilldownで「同一訪問者」をvisitor_idを晒さずに
        // 判別するための一方向ハッシュ（visitorToken）。生のvisitor_idは保存しない。
        visitor_hash: event.visitorId ? visitorToken(event.visitorId) : '',
        created_at: FieldValue.serverTimestamp()
      });

      const result = await recordWebEvent(event, new Date());

      return res.status(200).json({ success: true, aggregate: result });
    } catch (err) {
      console.error('logInteraction error:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

exports.submitOtherInquiry = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['LINE_ACCESS_TOKEN', 'ADMIN_LINE_USER_ID', 'FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    // --- CORS チェック（allowlist 方式。web.app は登録済み）---
    if (!setCorsHeaders(req, res)) {
      return res.status(403).json({ error: 'Forbidden: Origin not allowed' });
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // --- Content-Type チェック ---
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }

    let body;
    try {
      body = parseRequestBody(req);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const b = body || {};
    const isTest = isAuthorizedTestEvent(b.test_event, req.headers.authorization, process.env.FUNNEL_DASHBOARD_TOKEN);

    // --- 必須フィールドチェック ---
    const trimmedName = optionalString(b.name, 50);
    if (!trimmedName) {
      return res.status(400).json({ error: 'name is required' });
    }

    const works = Array.isArray(b.works)
      ? b.works.map((w) => optionalString(w, 50)).filter(Boolean).slice(0, 20)
      : [];

    const data = {
      name:   trimmedName,
      city:   optionalString(b.city, 200),
      date1:  optionalString(b.date1, 20),
      time1:  optionalString(b.time1, 20),
      date2:  optionalString(b.date2, 20),
      time2:  optionalString(b.time2, 20),
      date3:  optionalString(b.date3, 20),
      time3:  optionalString(b.time3, 20),
      works,
      detail: optionalString(b.detail, 1000),
      source: optionalString(b.source, 100),
      landing_page: optionalString(b.landing_page, 500),
      referrer: optionalString(b.referrer, 500),
      formType: 'other',
      test_event: isTest,
      userAgent: optionalString(req.headers['user-agent'], 500),
      createdAt: FieldValue.serverTimestamp()
    };

    // --- Firestore 保存 ---
    try {
      const inquiryRef = await db.collection('other_inquiries').add(data);
      try {
        await recordInternalMetric('inquirySubmits', `form_${inquiryRef.id}`, data.source || 'フォーム', new Date(), isTest);
      } catch (metricError) {
        console.error('submitOtherInquiry: funnel metric failed:', metricError);
      }
    } catch (err) {
      console.error('submitOtherInquiry: Firestore save failed:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    // --- LINE Messaging API push（管理者のみ。broadcast は使用禁止）---
    // Firestore 保存後に独立して実行。失敗しても送信成功を返す。
    const worksText = works.length > 0 ? works.join('・') : 'なし';
    const datesText =
      `第1希望: ${data.date1 || '-'} ${data.time1 || '-'}\n` +
      `第2希望: ${data.date2 || '-'} ${data.time2 || '-'}\n` +
      `第3希望: ${data.date3 || '-'} ${data.time3 || '-'}`;
    const lineMessage =
      `【その他のご依頼】\n\n` +
      `名前: ${data.name}\n` +
      `住所: ${data.city || 'なし'}\n` +
      `依頼内容: ${worksText}\n` +
      `${datesText}\n` +
      `備考: ${data.detail || 'なし'}`;
    await sendAdminLinePush(axios, {
      context: 'submitOtherInquiry',
      token: process.env.LINE_ACCESS_TOKEN,
      to: process.env.ADMIN_LINE_USER_ID,
      messages: [{ type: 'text', text: lineMessage }]
    });

    return res.status(200).json({ success: true });
  }
);

exports.lineWebhook = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['LINE_CHANNEL_SECRET']
  },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from('');
    if (!verifyLineSignature(rawBody, req.headers['x-line-signature'], process.env.LINE_CHANNEL_SECRET)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (error) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    try {
      let recorded = 0;
      for (const event of Array.isArray(payload.events) ? payload.events : []) {
        if (await recordLineEvent(event)) recorded += 1;
      }
      return res.status(200).json({ success: true, recorded });
    } catch (error) {
      console.error('lineWebhook failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

exports.syncSalesFunnel = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireDashboardToken(req, res)) return;
    let body;
    try {
      body = parseRequestBody(req);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    let days;
    try {
      days = normalizeSalesDays(body.days);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    try {
      const batch = db.batch();
      days.forEach((day) => {
        batch.set(db.collection('funnel_sales_daily').doc(day.date), Object.assign({}, day, {
          source: 'aoki-sales-os',
          syncedAt: FieldValue.serverTimestamp()
        }));
      });
      batch.set(db.collection('funnel_meta').doc('sales_sync'), {
        source: optionalString(body.source, 100) || 'aoki-sales-os',
        dayCount: days.length,
        syncedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await batch.commit();
      return res.status(200).json({ success: true, dayCount: days.length });
    } catch (error) {
      console.error('syncSalesFunnel failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

exports.getFunnelDashboard = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN', 'LINE_ACCESS_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireDashboardToken(req, res)) return;
    const period = ['thisMonth', 'lastMonth', 'thisWeek'].includes(req.query.period)
      ? req.query.period
      : 'thisMonth';
    const bounds = periodBounds(period, new Date());

    try {
      const [siteSnapshot, salesSnapshot, lineInsight] = await Promise.all([
        db.collection('funnel_daily').where('date', '>=', bounds.start).where('date', '<=', bounds.end).get(),
        db.collection('funnel_sales_daily').where('date', '>=', bounds.start).where('date', '<=', bounds.end).get(),
        getLineInsight()
      ]);
      const siteRows = siteSnapshot.docs.map((doc) => doc.data());
      const salesRows = salesSnapshot.docs.map((doc) => doc.data());
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(dashboardPayload(Object.assign({ key: period }, bounds), siteRows, salesRows, lineInsight));
    } catch (error) {
      console.error('getFunnelDashboard failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/**
 * ダッシュボードdrilldown（2026-08-30追加）：AOKI OS共通原則「集計数字は根拠データまで
 * 降りられること」に対応。getFunnelDashboardが返すmetrics[metric]と件数が必ず一致する
 * よう、同じ期間定義（periodBounds）・同じ除外ルール（funnelDrilldown＝aggregateRowsと
 * 同じLEGACY_TEST_EXCLUSIONS/is_test判定）を使う。既存のgetFunnelDashboardとは別関数
 * だが、新しいFirestoreコレクション・新しい正本は作らない（既存interaction_logs／
 * funnel_dailyを読むだけの読み取り専用API）。
 */
exports.getFunnelDrilldown = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireDashboardToken(req, res)) return;
    const period = ['thisMonth', 'lastMonth', 'thisWeek'].includes(req.query.period)
      ? req.query.period
      : 'thisMonth';
    const metric = String(req.query.metric || '');
    const bounds = periodBounds(period, new Date());
    try {
      const result = await funnelDrilldown(db, metric, bounds);
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(Object.assign({ period: Object.assign({ key: period }, bounds) }, result));
    } catch (error) {
      if (error && error.message === 'Unsupported drilldown metric') {
        return res.status(400).json({ error: error.message });
      }
      console.error('getFunnelDrilldown failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/**
 * 集客ファネル分析（2026-08-31追加：集客ファネル知性化）：見込み度の内訳／流入元別の質／
 * 離脱ポイントを、期間全体でまとめて返す読み取り専用API。getFunnelDrilldownの個別訪問
 * 一覧とは別に、営業ダッシュボード側の「集客ファネル」分析タブが使う集計値だけを提供する。
 * 新しいFirestoreコレクションは作らず、既存interaction_logs／funnel_dailyを読むだけ。
 */
exports.getFunnelInsights = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireDashboardToken(req, res)) return;
    const period = ['thisMonth', 'lastMonth', 'thisWeek'].includes(req.query.period)
      ? req.query.period
      : 'thisMonth';
    const bounds = periodBounds(period, new Date());
    try {
      const result = await funnelInsights(db, bounds);
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(Object.assign({ period: Object.assign({ key: period }, bounds) }, result));
    } catch (error) {
      console.error('getFunnelInsights failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/**
 * 「今日」画面のコンパクトな集客通知向けAPI（2026-08-31追加）。過去24時間の実データだけを
 * 見て、営業上意味のある動きの有無・件数だけを返す（詳細な一覧はgetFunnelDrilldownを
 * 別途呼ぶ）。低価値な単発アクセスだけの場合はhasNotable:falseを返し、営業OS側は
 * カード自体を表示しない設計。
 */
exports.getFunnelRecentActivity = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireDashboardToken(req, res)) return;
    try {
      const result = await funnelRecentActivity(db, 24, new Date());
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(Object.assign({ ok: true }, result));
    } catch (error) {
      console.error('getFunnelRecentActivity failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

exports.funnelDashboard = onRequest(
  {
    region: 'us-central1',
    cors: false
  },
  (req, res) => {
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    return res.status(200).send(DASHBOARD_HTML);
  }
);
