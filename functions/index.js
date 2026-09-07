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
  buildLegacyPseudoSessions_,
  verifyVerifyJwt
} = require('./lib/funnelV2');

// 単位EF残実装（独立監査再提出）：見込み度の再訪判定はV1と同じ90日lookbackを使う
// （V1のREVISIT_LOOKBACK_DAYSと同じ値。funnel.js自体は無変更のため、この定数だけV2側で
// 独立定義する）。
const V2_REVISIT_LOOKBACK_DAYS = 90;
// VERIFY専用runtime service account（正本仕様：VERIFY writerへ専用runtime serviceAccount名を
// onRequest optionsで明示する）。Secret Manager側の作成・IAM最小権限設定は人間が実施する
// （このセッションではSecret/IAM操作を一切行っていない。詳細は監査ZIP同梱の
// secret_iam_plan/VERIFY_SECRET_IAM_SETUP_PLAN.mdを参照）。実際にこのservice accountが
// 存在しない状態でdeployすると失敗する＝人間の事前作業が必須であることが自然に強制される。
const VERIFY_RUNTIME_SERVICE_ACCOUNT = 'funnel-verify-runtime@aokitosou-miniapp.iam.gserviceaccount.com';

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
    // 独立監査再提出・項目7：referrerHostのクライアント生値は受け取らない・保存しない
    // （rawFrom/rawReferrerのような重複証跡フィールドを作らない）。funnelV2.js側の
    // recordWebEventV2が、サーバー検証済みのwebSource/webSourceStatusから
    // referrer_hostを導出する（webSourceStatus==='referrer'の場合のみ、その値を使う）。
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
 * 正式名：logInteractionV2Verify（aud同名）。専用runtime service accountを明示する。
 *
 * secrets配列にVERIFY_JWT_SECRETを含める（Secret Managerでの作成・IAMアクセス制限
 * ＝info@aoki-tosou.netと専用service accountのみへの限定は、今回のセッションでも
 * 未実施＝人間の実施が必要。詳細は監査ZIP同梱のsecret_iam_plan/を参照）。
 */
exports.logInteractionV2Verify = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['VERIFY_JWT_SECRET'],
    serviceAccount: VERIFY_RUNTIME_SERVICE_ACCOUNT
  },
  async (req, res) => {
    // 独立監査再提出R8・項目2：以前はOPTIONSへ204を返すだけでCORSヘッダーを
    // 一切設定しておらず（POST応答にも同様に無かった）、実ブラウザからのCORS
    // preflight・実リクエストの双方が失敗していた（Node fetchベースのE2Eは
    // ブラウザCORSを再現しないため、この欠陥をこれまで検知できていなかった）。
    // OPTIONS・POSTのどちらの応答経路でも必ずCORSヘッダーを設定する。
    setVerifyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const verdict = verifyVerifyRequest_(req);
    if (!verdict.ok) return res.status(401).json({ error: 'Unauthorized' });

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
      console.error('logInteractionV2Verify failed:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/** logInteractionV2Verify（書き込み専用）のJWT検証（Authorization: Bearerヘッダ）。
 * 監査差し戻し（独立監査再提出R6）#4：VERIFY_JWT_SECRET（署名鍵）はこの書き込み
 * エンドポイントだけが使う。以前はVERIFY読み取り3系もこの関数を（audだけ変えて）
 * 共用していたが、読み取り3系はrequireVerifyReadToken（別の固定トークン）へ
 * 切り替えたため、このJWT検証の呼び出し元はlogInteractionV2Verifyのみになった。 */
function verifyVerifyRequest_(req) {
  const token = extractBearerToken(req.headers.authorization);
  return verifyVerifyJwt(token, process.env.VERIFY_JWT_SECRET, {
    expectedAud: 'logInteractionV2Verify',
    expectedScope: 'write:interaction_logs_v2_verify',
    expectedSub: 'info@aoki-tosou.net'
  });
}

/** 期間の[startAt, endAt)エポックms境界を計算する（V1のperiodBounds＋JST日境界と同じ規則）。 */
function v2PeriodBoundsMs_(bounds) {
  return {
    startAt: new Date(`${bounds.start}T00:00:00.000+09:00`).getTime(),
    endAt: new Date(`${shiftDateKey(bounds.end, 1)}T00:00:00.000+09:00`).getTime()
  };
}

/** legacy（visit_idを持たないraw log）を、V1のgroupVisits_がそのまま受け取れる形状
 * （eventType/dayKey/visitorHashValue）へ整形し、hash有り（legacy_unknown）／
 * hash無し（legacy_hash_missing）に分けて返す。isTestは除外する（単位6）。
 * 監査差し戻し（独立監査再提出R6）#1：V1 logInteraction起源のraw logには
 * occurred_atフィールドが存在しない（created_atのみ、FieldValue.serverTimestamp()）。
 * occurred_atでwhereすると、legacy行は構造的に0件しかヒットしない
 * （旧ログ／判定不能が常に過小＝実質ゼロになるバグ）。legacyの期間特定は
 * created_atで行う。legacy判定そのものはclassifyLogCategory内でvisit_idの
 * 有無だけを見ており（occurred_atには一切依存しない）、V2行（occurred_at・
 * visit_idともに保持）もこのcreated_atクエリには混ざって返るが、classifyLogCategoryが
 * new_reliable/new_unreliableへ分類し以下のフィルタで除外されるため問題ない。
 * 監査差し戻し（独立監査再提出R7）#4：行の形状へat（created_atのepoch ms）・
 * from・referrer・docId（Firestoreドキュメントid）を追加した。buildLeadScoreBreakdownV2
 * は従来どおりeventType/dayKey/visitorHashValueだけを見るため無影響のまま、
 * funnelV2.jsのbuildLegacyPseudoSessions_（legacyをV2のvisit_sessionsと同じ形状へ
 * 変換し、真にV2の集計パイプラインへ合流させる。「除外してlegacyAttributionScopeへ
 * 書くだけ」では後方互換契約を満たさないという指摘への対応）が、この追加フィールドを使う。
 * 監査差し戻し（独立監査再提出R8）#6：sourceフィールドも追加した。from保存開始
 * （2026-08-31）より前に記録されたraw logはfromが空のままだが、source列には
 * V1クライアント（js/analytics.js）が計算していたfrom／UTM／referrer統合値が
 * 残っている可能性がある。以前はこの情報を一切読まずに捨てており、from保存開始前の
 * 旧ログは実際には媒体・参照元情報を持っていても常にmediaValidity='none'へ縮退して
 * いた（有効な旧情報の損失）。funnelV2.jsのderiveLegacyMediaAndSource_が、fromが
 * 空の行に限りこのsourceから安全な復元を試みる（fromが存在する行はfrom優先・
 * sourceは無視。詳細はrecoverLegacySourceLabel_のコメント参照）。 */
async function fetchLegacyRowsForGrouping_(collections, startAt, endAt) {
  const snapshot = await db.collection(collections.interactionLogs)
    .where('created_at', '>=', new Date(startAt)).where('created_at', '<', new Date(endAt)).get();
  const hashPresentRows = [];
  const hashMissingRows = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    if (data.is_test) return;
    const category = classifyLogCategory(data);
    if (category !== 'legacy_unknown' && category !== 'legacy_hash_missing') return;
    const createdAt = data.created_at && typeof data.created_at.toDate === 'function' ? data.created_at.toDate() : null;
    if (!createdAt) return;
    const row = {
      eventType: String(data.event_type || ''), dayKey: jstDateKey(createdAt), visitorHashValue: String(data.visitor_hash || ''),
      at: createdAt.getTime(), from: String(data.from || ''), referrer: String(data.referrer || ''),
      source: String(data.source || ''), docId: doc.id
    };
    (category === 'legacy_unknown' ? hashPresentRows : hashMissingRows).push(row);
  });
  return { hashPresentRows, hashMissingRows };
}

/** 見込み度の再訪判定用：指定期間より前、V1と同じ90日lookbackのvisit_sessionsを取得する。 */
async function fetchPriorVisitSessions_(collections, beforeMs) {
  const lookbackStartAt = beforeMs - V2_REVISIT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const snapshot = await db.collection(collections.visitSessions)
    .where('startedAt', '>=', lookbackStartAt).where('startedAt', '<', beforeMs).get();
  return snapshot.docs.map((doc) => Object.assign({ visitId: doc.id }, doc.data()));
}

/**
 * 独立監査再提出R7・項目4：legacy（visit_idを持たない旧方式のraw log）を、V2の
 * mediaQuality／webSourceQuality・drilldown（visitors/lineClicks/phoneClicks）へも
 * 実際に合流させる。訂正：R6時点の実装は「legacyを除外してlegacyAttributionScopeへ
 * 書くだけ」であり、これはV2 reader後方互換契約を満たさないという指摘を受けた。
 * funnelV2.jsのbuildLegacyPseudoSessions_が、legacy raw log行をV2のvisit_sessionsと
 * 同じ形状の疑似セッションへ変換する（hash有りはV1のgroupVisits_と同じdayKey+
 * visitor_hash単位でvisit化、hash無しはpage_view単位の個別未識別訪問、reactionは
 * 訪問へ推測結合せず個別のreaction-onlyとして扱う）。この疑似セッションをV2の
 * 実visit_sessionsへ連結してからbuildQualityAxes等の既存集計ロジックへそのまま渡す
 * ため、集計ロジック自体（buildQualityAxes・buildLeadScoreBreakdownV2）は無変更。
 * legacy由来の項目は、visitId/legacyVisitIdが"legacy:"で始まることで判別できる。
 */
const V2_LEGACY_ATTRIBUTION_SCOPE = {
  legacyIncludedIn: ['leadScoreBreakdown.旧ログ', 'leadScoreBreakdown.判定不能', 'mediaQuality', 'webSourceQuality', 'drilldown(metric=visitors)', 'drilldown(metric=lineClicks)', 'drilldown(metric=phoneClicks)'],
  rules: {
    hashPresent: 'visitor_hashが非空のlegacy page_view行は、V1のgroupVisits_と同じ日付＋visitor_hash単位で1visitへ集約する。訪問の媒体・Web参照元は、グループ内で最も早いpage_view行のfrom/referrerを採用する（V1のbuildVisitSummary_と同じ規則）。',
    hashMissing: 'visitor_hashが空のlegacy page_view行は、同一人物の判定根拠が無いため1行＝1visitとして個別に扱う（複数行を"(不明)"キーで1visitへ結合しない）。',
    reactions: 'legacyのline_click/phone_click行は、どの訪問に属するか安全に結合できないため、訪問へは一切紐付けずreaction-only（visitId相当が"legacy:reaction:<docId>"）として個別に扱う。存在しない訪問文脈を推測して結合しない。',
    mediaWebSourceNormalization: '媒体コード（from）・Web参照元（referrer）の正規化は、V2書き込み時の検証と同一のnormalizeMediaCode/normalizeWebSourceを再利用する（新しい検証ロジックを増やさない「安全な正規化」）。'
  },
  note: '独立監査再提出R7・項目4でlegacyを実際にV2と同じ集計パイプラインへ合流させた（除外ではない）。leadScoreBreakdownの5区分すべて・mediaQuality・webSourceQuality・drilldown（visitors/lineClicks/phoneClicks）のいずれにもlegacyが反映される。'
};

/**
 * media/webSource独立2軸、見込み度5区分（高・中・低・判定不能・旧ログ）、
 * legacy＋新方式4分類の集計を返す読み取り専用の中核処理（PROD/VERIFY共通）。
 * legacyの反映内容はV2_LEGACY_ATTRIBUTION_SCOPE参照（R7・項目4で実際に合流させた）。
 */
async function runV2InsightsQuery_(collections, period, levelFilter) {
  const bounds = periodBounds(period, new Date());
  const { startAt, endAt } = v2PeriodBoundsMs_(bounds);

  const sessionSnapshot = await db.collection(collections.visitSessions)
    .where('startedAt', '>=', startAt).where('startedAt', '<', endAt).get();
  const visitSessions = sessionSnapshot.docs.map((doc) => Object.assign({ visitId: doc.id }, doc.data()));

  const priorVisitSessions = await fetchPriorVisitSessions_(collections, startAt);
  const { hashPresentRows, hashMissingRows } = await fetchLegacyRowsForGrouping_(collections, startAt, endAt);
  const legacySessions = buildLegacyPseudoSessions_(hashPresentRows, hashMissingRows);

  // mediaQuality/webSourceQualityはV2実セッション＋legacy疑似セッションを合流させた
  // 集合から集計する（同じ媒体コード・Web参照元キーであれば、世代を問わず合算される）。
  const { mediaQuality, webSourceQuality } = buildQualityAxes(visitSessions.concat(legacySessions));
  // leadScoreBreakdown（見込み度5区分）は従来どおりV2実セッション＋legacy生行（V1互換の
  // 別集計ロジック）で計算する（見込み度自体はlegacy行から安全に判定できないため、
  // 旧ログ／判定不能という区分自体がlegacyの受け皿になっている。R6・項目1/2で修正済み）。
  const { counts, cards } = buildLeadScoreBreakdownV2(visitSessions, priorVisitSessions, hashPresentRows, hashMissingRows);
  const filteredCards = levelFilter ? cards.filter((c) => c.level === levelFilter) : cards;

  return {
    period: Object.assign({ key: period }, bounds),
    mediaQuality,
    webSourceQuality,
    leadScoreBreakdown: counts,
    leadScoreCards: filteredCards,
    legacyAttributionScope: V2_LEGACY_ATTRIBUTION_SCOPE
  };
}

/**
 * PROD V2 reader：media/webSource独立2軸、見込み度5区分の集計を返す読み取り専用API。
 * 既存getFunnelInsights（V1）とは別関数（V1は無変更のまま残す）。
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
    const period = ['thisMonth', 'lastMonth', 'thisWeek'].includes(req.query.period) ? req.query.period : 'thisMonth';
    const levelFilter = ['高', '中', '低', '判定不能'].includes(req.query.level) ? req.query.level : null;
    try {
      const result = await runV2InsightsQuery_(V2_PROD_COLLECTIONS, period, levelFilter);
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(result);
    } catch (error) {
      console.error('getFunnelInsightsV2 failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/**
 * VERIFY版getFunnelInsightsV2。JWT認可・VERIFY専用コレクションのみを読む。
 * DATA_ENV: VERIFY
 */
// 監査差し戻し（独立監査再提出R6）#4：読み取り専用エンドポイントはVERIFY_JWT_SECRET
// （書き込みJWT署名鍵）もfunnel-verify-runtime service accountも一切参照しない
// （requireVerifyReadToken＝専用の固定読み取りトークンのみで認可する）。
exports.getFunnelInsightsV2Verify = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['VERIFY_READ_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireVerifyReadToken(req, res)) return;
    const period = ['thisMonth', 'lastMonth', 'thisWeek'].includes(req.query.period) ? req.query.period : 'thisMonth';
    const levelFilter = ['高', '中', '低', '判定不能'].includes(req.query.level) ? req.query.level : null;
    try {
      const result = await runV2InsightsQuery_(V2_VERIFY_COLLECTIONS, period, levelFilter);
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(result);
    } catch (error) {
      console.error('getFunnelInsightsV2Verify failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/**
 * 個別訪問・反応の一覧（正本仕様：ドリルダウンはraw eventの帰属ではなくvisit_sessions
 * 正本へjoinする）。metric='visitors'はvisit_sessions（hasPageView===trueのみ）を直接返す。
 * metric='lineClicks'/'phoneClicks'はraw interaction_logsから個々のイベント時刻を取得し、
 * その視visit_idでvisit_sessionsへjoinして「そのイベントの時点でどの帰属が正本だったか」
 * ではなく「現在の正本（visit_sessionsの最新値）」を表示する（既存V1のfunnelDrilldownと
 * 同じ「今の正本を見せる」設計思想を踏襲）。isTestは除外する（単位6）。
 */
async function runV2DrilldownQuery_(collections, period, metric) {
  const bounds = periodBounds(period, new Date());
  const { startAt, endAt } = v2PeriodBoundsMs_(bounds);

  // 独立監査再提出R7・項目4：drilldown（visitors/lineClicks/phoneClicks）もlegacyを
  // 実際に合流させる。legacy行の取得・疑似セッション化はmetricによらず共通（後段で
  // metricごとに必要な形へ絞り込む）。
  const { hashPresentRows, hashMissingRows } = await fetchLegacyRowsForGrouping_(collections, startAt, endAt);
  const legacySessions = buildLegacyPseudoSessions_(hashPresentRows, hashMissingRows);

  if (metric === 'visitors') {
    const snapshot = await db.collection(collections.visitSessions)
      .where('startedAt', '>=', startAt).where('startedAt', '<', endAt).get();
    const v2Items = snapshot.docs
      .map((doc) => Object.assign({ visitId: doc.id }, doc.data()))
      .filter((v) => v.isTest !== true && v.hasPageView === true)
      .map((v) => ({
        at: new Date(v.startedAt).toISOString(),
        visitId: v.visitId,
        mediaCode: v.mediaValidity === 'valid' ? v.mediaCode : '',
        mediaValidity: v.mediaValidity,
        webSource: v.webSource,
        webSourceStatus: v.webSourceStatus,
        pageViewCount: Number(v.pageViewCount || 0),
        reactionCount: Number(v.reactionCount || 0)
      }));
    // legacyの訪問（hasPageView===trueの疑似セッションのみ。reaction-onlyはmetric=
    // visitorsには含めない）をV2訪問一覧と同じ形へ変換して合流させる。visitIdは
    // "legacy:"で始まる合成値（legacyVisitId）＝visit_sessionsドキュメントを持たない
    // legacy由来であることが呼び出し元でも判別できる。
    const legacyItems = legacySessions
      .filter((s) => s.hasPageView === true)
      .map((s) => ({
        at: new Date(s.startedAt).toISOString(),
        visitId: s.legacyVisitId,
        mediaCode: s.mediaValidity === 'valid' ? s.mediaCode : '',
        mediaValidity: s.mediaValidity,
        webSource: s.webSource,
        webSourceStatus: s.webSourceStatus,
        pageViewCount: Number(s.pageViewCount || 0),
        reactionCount: Number(s.reactionCount || 0)
      }));
    const items = v2Items.concat(legacyItems).sort((a, b) => new Date(b.at) - new Date(a.at));
    return { kind: 'visit', metric, items, total: items.length, legacyAttributionScope: V2_LEGACY_ATTRIBUTION_SCOPE };
  }

  const eventTypeByMetric = { lineClicks: 'line_click', phoneClicks: 'phone_click' };
  const eventType = eventTypeByMetric[metric];
  if (!eventType) throw new Error('Unsupported drilldown metric');

  const logSnapshot = await db.collection(collections.interactionLogs)
    .where('event_type', '==', eventType).where('occurred_at', '>=', startAt).where('occurred_at', '<', endAt).get();
  const rows = logSnapshot.docs.map((doc) => doc.data()).filter((r) => r.is_test !== true);

  // raw eventの帰属ではなくvisit_sessions正本へjoinする（正本仕様）。
  const visitIds = Array.from(new Set(rows.map((r) => r.visit_id).filter(Boolean)));
  const sessionDocs = await Promise.all(visitIds.map((id) => db.collection(collections.visitSessions).doc(id).get()));
  const sessionById = new Map();
  sessionDocs.forEach((snap) => { if (snap.exists) sessionById.set(snap.id, snap.data()); });

  const v2Items = rows.map((r) => {
    const session = sessionById.get(r.visit_id) || null;
    return {
      at: new Date(r.occurred_at).toISOString(),
      visitId: r.visit_id || '',
      mediaCode: session && session.mediaValidity === 'valid' ? session.mediaCode : '',
      mediaValidity: session ? session.mediaValidity : null,
      webSource: session ? session.webSource : null,
      webSourceStatus: session ? session.webSourceStatus : null,
      visitPageViewCount: session ? Number(session.pageViewCount || 0) : null
    };
  });
  // legacyのreaction（line_click/phone_click）は、どの訪問に属するか安全に結合できない
  // ため、visitPageViewCount=null（不明。V2のようにvisit_sessions正本へjoinできる
  // visit_idが無い）のまま、訪問へ推測結合せず個別のitemとして合流させる
  // （legacyVisitIdが"legacy:reaction:<docId>"＝結合していないことが判別できる）。
  const legacyItems = legacySessions
    .filter((s) => s.legacySource === 'legacy_reaction' && s.legacyReactionEventType === eventType)
    .map((s) => ({
      at: new Date(s.startedAt).toISOString(),
      visitId: s.legacyVisitId,
      mediaCode: s.mediaValidity === 'valid' ? s.mediaCode : '',
      mediaValidity: s.mediaValidity,
      webSource: s.webSource,
      webSourceStatus: s.webSourceStatus,
      visitPageViewCount: null
    }));
  const items = v2Items.concat(legacyItems).sort((a, b) => new Date(b.at) - new Date(a.at));
  return { kind: 'event', metric, items, total: items.length, legacyAttributionScope: V2_LEGACY_ATTRIBUTION_SCOPE };
}

/**
 * PROD V2版getFunnelDrilldown。既存getFunnelDrilldown（V1）とは別関数（V1は無変更）。
 * DATA_ENV: PROD_V2
 */
exports.getFunnelDrilldownV2 = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireDashboardToken(req, res)) return;
    const period = ['thisMonth', 'lastMonth', 'thisWeek'].includes(req.query.period) ? req.query.period : 'thisMonth';
    const metric = String(req.query.metric || '');
    try {
      const result = await runV2DrilldownQuery_(V2_PROD_COLLECTIONS, period, metric);
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(Object.assign({ period: periodBounds(period, new Date()) }, result));
    } catch (error) {
      if (error && error.message === 'Unsupported drilldown metric') return res.status(400).json({ error: error.message });
      console.error('getFunnelDrilldownV2 failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/**
 * VERIFY版getFunnelDrilldownV2。
 * DATA_ENV: VERIFY
 */
exports.getFunnelDrilldownV2Verify = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['VERIFY_READ_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireVerifyReadToken(req, res)) return;
    const period = ['thisMonth', 'lastMonth', 'thisWeek'].includes(req.query.period) ? req.query.period : 'thisMonth';
    const metric = String(req.query.metric || '');
    try {
      const result = await runV2DrilldownQuery_(V2_VERIFY_COLLECTIONS, period, metric);
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(Object.assign({ period: periodBounds(period, new Date()) }, result));
    } catch (error) {
      if (error && error.message === 'Unsupported drilldown metric') return res.status(400).json({ error: error.message });
      console.error('getFunnelDrilldownV2Verify failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/**
 * 直近24時間の「今日」パルス向け軽量サマリ。V1のfunnelRecentActivityと同じ目的だが、
 * V2ネイティブのvisit_sessionsだけを使う。
 *
 * 独立監査再提出R6・項目10で、V1が持つ2つのフィールドの扱いを確定させた（「EF完成」を
 * 主張するのではなく、それぞれのスコープを明示する）：
 * - revisitImproved：実装した。buildLeadScoreBreakdownV2が既に呼んでいる
 *   computeSessionLeadScoreV1Compat_（V1のcomputeLeadScore_をそのまま使う）の
 *   revisit.deeperThanPrevious／revisit.strongerReactionThanPrevious判定結果を
 *   そのまま数える（V1のfunnelRecentActivityと同一の定義・同一の判定式）。
 * - lineFollowIncrease：今回のV2切替のスコープから明示的に除外する（実装しない）。
 *   LINE公式アカウントの友だち増減はLINE Webhook（lineWebhook、schemaVersion:2の
 *   analyticsイベントパイプラインとは別の入力経路・別のデータ形状）でのみ観測でき、
 *   このV2 reader（visit_sessions／interaction_logsのみを読む設計）の対象データには
 *   一切含まれない。将来対応する場合は、LINE Webhookイベントの集計を別途this関数へ
 *   結合する設計が必要（今回は未着手）。応答にはlineFollowIncrease: nullと
 *   lineFollowIncreaseExcludedReasonを返し、フィールドを黙って省略したり0で
 *   ごまかしたりしない（呼び出し側の契約：nullは「対応外」、0は「対応済みで実測0件」
 *   と区別できる）。
 */
async function runV2RecentActivityQuery_(collections, hours) {
  const now = new Date();
  const startAt = now.getTime() - hours * 60 * 60 * 1000;
  const sessionSnapshot = await db.collection(collections.visitSessions).where('startedAt', '>=', startAt).get();
  const visitSessions = sessionSnapshot.docs.map((doc) => Object.assign({ visitId: doc.id }, doc.data())).filter((v) => v.isTest !== true);
  const priorVisitSessions = await fetchPriorVisitSessions_(collections, startAt);
  const { counts, revisitImproved } = buildLeadScoreBreakdownV2(visitSessions, priorVisitSessions, [], []);
  const newVisits = visitSessions.filter((v) => v.hasPageView === true).length;
  const lineOrPhoneReactions = visitSessions.reduce((sum, v) => sum + Number(v.reactionCount || 0), 0);
  const highLeadVisits = counts.高;
  const hasNotable = newVisits > 0 || lineOrPhoneReactions > 0 || revisitImproved > 0;
  return {
    hasNotable, newVisits, highLeadVisits, lineOrPhoneReactions, revisitImproved,
    lineFollowIncrease: null,
    lineFollowIncreaseExcludedReason: 'LINE友だち増減はLINE Webhook経由のデータであり、このV2 reader（visit_sessions／interaction_logsのみ）の対象外（独立監査再提出R6・項目10で明示的にスコープ除外）。'
  };
}

/**
 * PROD V2版getFunnelRecentActivity。
 * DATA_ENV: PROD_V2
 */
exports.getFunnelRecentActivityV2 = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['FUNNEL_DASHBOARD_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireDashboardToken(req, res)) return;
    try {
      const result = await runV2RecentActivityQuery_(V2_PROD_COLLECTIONS, 24);
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(Object.assign({ ok: true }, result));
    } catch (error) {
      console.error('getFunnelRecentActivityV2 failed:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

/**
 * VERIFY版getFunnelRecentActivityV2。
 * DATA_ENV: VERIFY
 */
exports.getFunnelRecentActivityV2Verify = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['VERIFY_READ_TOKEN']
  },
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!requireVerifyReadToken(req, res)) return;
    try {
      const result = await runV2RecentActivityQuery_(V2_VERIFY_COLLECTIONS, 24);
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(Object.assign({ ok: true }, result));
    } catch (error) {
      console.error('getFunnelRecentActivityV2Verify failed:', error);
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

/**
 * VERIFY writer（logInteractionV2Verify）専用のCORSヘッダー設定（独立監査再提出R8・
 * 項目2への対応）。
 *
 * PROD writer（logInteractionV2）のsetCorsHeaders()は、本番サイトの既知オリジン
 * （ALLOWED_ORIGINS）だけを許可するallowlist方式であり、それ以外のOriginは403で
 * 拒否する。これはPRODが「本番サイトからのみ呼ばれる」という前提に立つ設計であり、
 * 正しい。
 *
 * 一方VERIFYは、JWT Bearerを唯一の認可正本とする設計であり（cookie認証・
 * Access-Control-Allow-Credentialsは一切使わない）、そもそも「ローカル検証ページ
 * （localhost・file://・その他任意のOrigin）から呼べる」ことが要件になっている。
 * PRODと同じOrigin allowlistを適用すると、この要件を構造的に満たせない
 * （ローカル検証ページのOriginは絶対にALLOWED_ORIGINSへ含められない＝含めると
 * 本番サイトの既知オリジン一覧という意味が壊れる）。
 *
 * Credentialsを一切送らない（Access-Control-Allow-Credentialsを設定しない）設計で
 * あれば、リクエストのOriginをそのまま反射する（無ければワイルドカード）ことに
 * 秘匿情報漏洩のリスクは無い：ブラウザはAccess-Control-Allow-Credentials:trueが
 * 無い限りCookie等の資格情報を一切送らないため、CORSの「Originを許可した」ことが
 * 意味する範囲は「レスポンス本文をそのOriginのJSから読めるようにする」ことだけであり、
 * 実際の認可はJWT Bearer（Authorizationヘッダー。CORS preflightの対象であり、
 * ブラウザは許可されたOriginへしかAuthorizationヘッダー付きの実リクエストを
 * 進めない）が担う。
 *
 * OPTIONS（preflight）・POST（実リクエスト。401/400/200等どの応答でも）の両方に
 * 必ず呼ぶこと（呼び出し漏れがあると、そのレスポンスだけブラウザ側でCORSエラーに
 * なり、実際にはサーバー側の処理が成功していてもクライアントからは失敗に見える）。
 */
function setVerifyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  res.set('Access-Control-Allow-Origin', origin || '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Vary', 'Origin');
  // Access-Control-Allow-Credentialsは意図的に設定しない（cookie認証を使わない設計）。
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

/** VERIFY読み取り3系（getFunnelInsightsV2Verify／getFunnelDrilldownV2Verify／
 * getFunnelRecentActivityV2Verify）専用の認可。監査差し戻し（独立監査再提出R6）#4：
 * VERIFY_JWT_SECRET（署名鍵）・funnel-verify-runtime service accountは
 * logInteractionV2Verify（書き込み専用）だけが使える必要があり、読み取り3系は
 * どちらも一切参照してはならない。FUNNEL_DASHBOARD_TOKEN（PROD読み取りが使う既存の
 * 固定トークン）とも別に、VERIFY読み取り専用の固定トークンVERIFY_READ_TOKENを新設し、
 * 署名鍵からもPROD読み取りトークンからも完全に分離する（VERIFY環境の隔離原則を
 * 認可トークンの面でも維持する）。 */
function requireVerifyReadToken(req, res) {
  if (!authorizeBearer(req.headers.authorization, process.env.VERIFY_READ_TOKEN)) {
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
