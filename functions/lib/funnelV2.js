'use strict';

/**
 * Web流入媒体識別精度改善・単位EF（2026-09-07・ローカル実装検証）。
 * 既存V1（functions/lib/funnel.js）は無変更のまま、V2の新規ロジックをこの独立モジュールへ
 * 実装する。funnel.jsが持つ正規化・翻訳ヘルパー（normalizeLabel/hostnameOf_相当）は
 * 意図的に再利用せず、V2独自の検証を持つ（V1の挙動を一切変えないため）。
 *
 * 本ファイルはローカルworktree（feature/funnel-media-precision-v1-ef）上での実装であり、
 * 現時点でPRODUCTIONへdeployされていない。functions/index.jsへは、この単位EF作業の中で
 * 別途 exports.*V2 / exports.*V2Verify を追加する（本ファイルはそのロジック本体）。
 */

const crypto = require('crypto');

const JST_TIME_ZONE = 'Asia/Tokyo';

/* ============================================================================
 * 検証・正規化
 * ============================================================================ */

const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{12,100}$/;
const VISIT_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const MEDIA_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_TYPES = Object.freeze(['page_view', 'line_click', 'phone_click']);
const OCCURRED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // 未来5分
const OCCURRED_AT_PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000; // 過去24時間

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * schemaVersion:2 payloadの中核5フィールド（event_id/visit_id/occurredAt/eventType/
 * schemaVersion）だけを検証する。ここで失敗した場合のみ400拒否する契約（正本仕様§5）。
 * 戻り値: { ok:true, core:{...} } または { ok:false, error:'...' }
 */
function validateCoreFields(body, now) {
  if (!isPlainObject(body)) return { ok: false, error: 'Invalid JSON body' };
  if (body.schemaVersion !== 2) return { ok: false, error: 'schemaVersion must be 2' };

  const eventId = String(body.event_id || '');
  if (!EVENT_ID_PATTERN.test(eventId)) return { ok: false, error: 'Invalid event_id' };

  // visit_idは欠損・不正いずれも400拒否（V2 writerは厳格。legacy受理はV1 writerのみ）。
  const visitId = String(body.visit_id || '');
  if (!VISIT_ID_PATTERN.test(visitId)) return { ok: false, error: 'Invalid visit_id' };

  const occurredAt = Number(body.occurredAt);
  if (!Number.isInteger(occurredAt)) return { ok: false, error: 'Invalid occurredAt' };
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  if (occurredAt > nowMs + OCCURRED_AT_FUTURE_TOLERANCE_MS) return { ok: false, error: 'occurredAt is too far in the future' };
  if (occurredAt < nowMs - OCCURRED_AT_PAST_TOLERANCE_MS) return { ok: false, error: 'occurredAt is too far in the past' };

  const eventType = String(body.eventType || '');
  if (EVENT_TYPES.indexOf(eventType) < 0) return { ok: false, error: 'Invalid eventType' };

  return { ok: true, core: { eventId, visitId, occurredAt, eventType } };
}

/** mediaCode（visitMediaCode）の検証。中核フィールドとは異なりソフト縮退のみ（400にしない）。
 * 戻り値: { mediaCode, mediaValidity } — mediaValidity: 'valid'|'invalid'|'none' */
function normalizeMediaCode(rawVisitMediaCode) {
  const code = String(rawVisitMediaCode == null ? '' : rawVisitMediaCode).trim();
  if (!code) return { mediaCode: '', mediaValidity: 'none' };
  if (!MEDIA_CODE_PATTERN.test(code)) return { mediaCode: '', mediaValidity: 'invalid', invalidMediaCodeHash: hashDiagnostic_(code) };
  return { mediaCode: code, mediaValidity: 'valid' };
}

/** webSource（visitWebSource）の検証。クライアントが計算済みの値をサーバーで再検証する。
 * 許容する値は 'direct'、正規化済みホスト名らしき文字列（簡易チェック）、または空文字（none）。
 * 戻り値: { webSource, webSourceStatus } — webSourceStatus: 'referrer'|'direct'|'none'|'invalid' */
const WEB_SOURCE_HOST_PATTERN = /^[a-z0-9.-]{1,253}$/;
function normalizeWebSource(rawVisitWebSource) {
  const value = String(rawVisitWebSource == null ? '' : rawVisitWebSource).trim();
  if (value === '') return { webSource: '', webSourceStatus: 'none' };
  if (value === 'direct') return { webSource: 'direct', webSourceStatus: 'direct' };
  const lower = value.toLowerCase();
  if (WEB_SOURCE_HOST_PATTERN.test(lower)) return { webSource: lower, webSourceStatus: 'referrer' };
  return { webSource: '', webSourceStatus: 'invalid', invalidWebSourceHash: hashDiagnostic_(value) };
}

/** 不正値の診断ハッシュ（生値は一切保持しない）。 */
function hashDiagnostic_(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** visitorId／visitorIdPersistedの全組合せ判定（正本仕様§7-1）。
 * 欠損・型不正のvisitorIdPersistedも受理する（今回訂正）。 */
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
function evaluateVisitorIdentity(rawVisitorId, rawVisitorIdPersisted) {
  const visitorIdPersisted = rawVisitorIdPersisted === true ? true : (rawVisitorIdPersisted === false ? false : null); // null=欠損/型不正
  const visitorId = String(rawVisitorId == null ? '' : rawVisitorId);
  const visitorIdValid = VISITOR_ID_PATTERN.test(visitorId);

  let visitorIdStatus;
  if (visitorIdPersisted === null) visitorIdStatus = 'invalid'; // persisted自体が欠損/型不正
  else if (!visitorIdValid) visitorIdStatus = 'invalid';
  else visitorIdStatus = 'ok';

  const hashReliable = visitorIdPersisted === true && visitorIdValid;
  const visitorHash = hashReliable ? computeVisitorHash(visitorId) : '';
  // 生visitorIdはこの関数の戻り値にも一切含めない（呼び出し側もハッシュ化後は破棄する）。
  return { visitorIdStatus, hashReliable, visitorHash };
}

function computeVisitorHash(visitorId) {
  return crypto.createHash('sha256').update(String(visitorId)).digest('hex').slice(0, 10);
}

/* ============================================================================
 * JST日付キー（V1のjstDateKeyと同一実装。funnel_daily契約互換のためV1へ依存せず複製する）
 * ============================================================================ */
function jstDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JST_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/* ============================================================================
 * 冪等Transaction契約（正本仕様§9）
 * ============================================================================ */

/**
 * (occurredAt, event_id) のタプル比較。aがbより古ければ true。
 * event_idは文字列昇順のみをtie-breakerとする（正本仕様§7訂正）。
 */
function isOlderTuple(a, b) {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt;
  return a.eventId < b.eventId;
}

/**
 * schemaVersion:2イベントを原子的に記録する。
 * - event_id重複はtransactionの原子性により「存在=完了済み」を保証する。
 * - funnel_dailyはV1と完全同一スキーマ・計算式で更新する（V1のrecordWebEventの計算式を
 *   そのまま複製。日付＝処理時刻＝new Date()基準。occurredAtは使わない＝V1互換優先）。
 * - visit_sessionsの媒体帰属正本7項目（mediaCode/mediaStatus.../webSource/webSourceStatus/
 *   attributionOccurredAt/attributionEventId/startedAt）は最小(occurredAt,event_id)の
 *   イベントを正本とし、より古いイベント後着時だけ7項目一括更新。それ以外の不一致は
 *   attributionMismatch=trueのみ立てる。
 * - hasPageViewはpage_view到達時にのみtrueへ更新する。
 *
 * @param {object} db Firestore（本番） or 隔離Firestore（VERIFY）
 * @param {object} collections {interactionLogs, funnelDaily, visitSessions} コレクション名
 * @param {object} event { eventId, visitId, occurredAt, eventType, mediaCode, mediaValidity,
 *   webSource, webSourceStatus, visitorHash, visitorIdStatus, source, contactChannel,
 *   currentPage, landingPage, referrer, isTest }
 * @param {Date} now transaction実行時刻（funnel_dailyのVI互換日付計算にのみ使用）
 */
async function recordWebEventV2(db, collections, event, now = new Date()) {
  const rawLogRef = db.collection(collections.interactionLogs).doc(event.eventId);
  const day = jstDateKey(now); // V1互換：処理時刻基準（functions/index.jsのrecordWebEvent(event,new Date())と同一規則）
  const dayRef = db.collection(collections.funnelDaily).doc(day);
  const visitSessionRef = db.collection(collections.visitSessions).doc(event.visitId);

  return db.runTransaction(async (transaction) => {
    const rawLogSnapshot = await transaction.get(rawLogRef);
    if (rawLogSnapshot.exists) {
      // transactionの原子性により、存在する時点で当時のtransaction全体（raw log＋
      // funnel_daily＋visit_sessions）が完了済みであることが構造的に保証される。
      return { recorded: false, duplicate: true };
    }

    const daySnapshot = await transaction.get(dayRef);
    const dayData = daySnapshot.exists ? daySnapshot.data() : {};
    const daily = {
      date: day,
      metrics: Object.assign({}, dayData.metrics || {}),
      testMetrics: Object.assign({}, dayData.testMetrics || {}),
      sources: Object.assign({}, dayData.sources || {}),
      testSources: Object.assign({}, dayData.testSources || {})
    };
    // V1のrecordWebEventと同一の計算式（PUBLIC_EVENT_COUNTERS相当）。
    const counterByEventType = { page_view: 'pageViews', line_click: 'lineClicks', phone_click: 'phoneClicks' };
    const counter = counterByEventType[event.eventType];
    if (counter) daily.metrics[counter] = Number(daily.metrics[counter] || 0) + 1;
    if (event.isTest && counter) daily.testMetrics[counter] = Number(daily.testMetrics[counter] || 0) + 1;

    const visitSessionSnapshot = await transaction.get(visitSessionRef);
    let visitSessionWrite = null;
    if (!visitSessionSnapshot.exists) {
      visitSessionWrite = {
        mediaCode: event.mediaCode, mediaValidity: event.mediaValidity,
        webSource: event.webSource, webSourceStatus: event.webSourceStatus,
        attributionOccurredAt: event.occurredAt, attributionEventId: event.eventId,
        startedAt: event.occurredAt,
        hasPageView: event.eventType === 'page_view',
        attributionMismatch: false
      };
    } else {
      const existing = visitSessionSnapshot.data();
      const existingTuple = { occurredAt: existing.attributionOccurredAt, eventId: existing.attributionEventId };
      const thisTuple = { occurredAt: event.occurredAt, eventId: event.eventId };
      const update = {};
      if (isOlderTuple(thisTuple, existingTuple)) {
        // より古いイベントの後着＝7項目を一括更新。
        update.mediaCode = event.mediaCode; update.mediaValidity = event.mediaValidity;
        update.webSource = event.webSource; update.webSourceStatus = event.webSourceStatus;
        update.attributionOccurredAt = event.occurredAt; update.attributionEventId = event.eventId;
        update.startedAt = event.occurredAt;
      } else if (existing.mediaCode !== event.mediaCode || existing.webSource !== event.webSource) {
        update.attributionMismatch = true;
      }
      if (event.eventType === 'page_view' && !existing.hasPageView) update.hasPageView = true;
      if (Object.keys(update).length) visitSessionWrite = update;
    }

    transaction.set(rawLogRef, {
      event_type: event.eventType,
      contact_channel: event.contactChannel || '',
      source: event.source || '',
      from: event.mediaCode || '',
      media_validity: event.mediaValidity,
      web_source: event.webSource || '',
      web_source_status: event.webSourceStatus,
      landing_page: event.landingPage || '',
      current_page: event.currentPage || '',
      referrer_host: event.referrerHost || '', // 正規化済みホストのみ（完全URLは保存しない）
      is_test: Boolean(event.isTest),
      visitor_hash: event.visitorHash || '',
      visitor_id_status: event.visitorIdStatus,
      visit_id: event.visitId,
      occurred_at: event.occurredAt,
      schema_version: 2,
      invalid_media_code_hash: event.invalidMediaCodeHash || null,
      invalid_web_source_hash: event.invalidWebSourceHash || null,
      created_at: now
    });
    transaction.set(dayRef, Object.assign(daily, { updatedAt: now }), { merge: true });
    if (visitSessionWrite) {
      transaction.set(visitSessionRef, visitSessionWrite, { merge: true });
    }
    return { recorded: true };
  });
}

/* ============================================================================
 * legacy/新方式 4分類（正本仕様§7）
 * ============================================================================ */

/** visit_idの有無・形式検証結果だけを正とする（日付は使わない）。 */
function isNewMethodLog(visitIdRaw) {
  return VISIT_ID_PATTERN.test(String(visitIdRaw || ''));
}

/**
 * 1件のraw log（interaction_logsドキュメント相当）を4区分へ分類する。
 * legacyの「信頼できる」は事後証明できないため常にlegacy_unknownとする（①）。
 */
function classifyLogCategory(row) {
  const isNewMethod = isNewMethodLog(row.visit_id);
  const hashPresent = Boolean(row.visitor_hash);
  if (!isNewMethod) {
    return hashPresent ? 'legacy_unknown' : 'legacy_hash_missing';
  }
  return row.hashReliable ? 'new_reliable' : 'new_unreliable';
}

/**
 * visit_sessionsの一覧から、媒体軸(mediaQuality)・Web参照元軸(webSourceQuality)を
 * 独立に集計する（正本仕様§8-2）。現行V1 Firebase APIを使う単位A/B/Cの間は、GAS側で
 * 既存の排他的sourceQualityをcategoryで表示分割するに留めていたが、単位EF（本モジュール）
 * のV2 APIでは、visit_sessionsのmediaCode/webSourceを独立に読むため、同一visitが
 * 両軸に真に独立して計上できる。
 */
function buildQualityAxes(visitSessions) {
  const mediaMap = new Map();
  const sourceMap = new Map();
  function mediaKeyOf(v) {
    if (v.mediaValidity === 'valid') return 'media:' + v.mediaCode;
    if (v.mediaValidity === 'invalid') return 'invalid';
    return null; // 'none'
  }
  function sourceKeyOf(v) {
    // 単位A/B/C期間はsourceKey=sourceLabelだが、EF後のV2 APIでは正規化webSource＋statusから
    // 導出する機械キーへ切り替える（正本仕様§10）。
    if (v.webSourceStatus === 'none' || v.webSourceStatus === 'invalid' || v.webSourceStatus === 'direct') {
      return v.webSourceStatus + ':' + (v.webSource || '');
    }
    return 'referrer:' + v.webSource;
  }
  visitSessions.forEach((v) => {
    // 媒体軸：mediaValidity='valid'|'invalid'の訪問だけを対象にする（'none'は対象外）。
    const mKey = mediaKeyOf(v);
    if (mKey) {
      if (!mediaMap.has(mKey)) mediaMap.set(mKey, { key: mKey, mediaCode: v.mediaValidity === 'invalid' ? '' : v.mediaCode, mediaValidity: v.mediaValidity, visits: 0 });
      mediaMap.get(mKey).visits += 1;
    }
    // Web参照元軸：媒体の有無・有効性に関わらず、全訪問を独立に計上する（同一visitが
    // 両軸へ1回ずつ出現可能。invalid媒体でも有効webSourceがあれば独立計上する＝
    // 正本仕様§8-2・監査追補#2）。webSourceStatus='none'（媒体はあるが参照元情報なし）は
    // 'direct'（真の直接アクセス）とは別バケットとして必ず区別する。
    const sKey = sourceKeyOf(v);
    if (!sourceMap.has(sKey)) sourceMap.set(sKey, { key: sKey, webSource: v.webSource, webSourceStatus: v.webSourceStatus, visits: 0 });
    sourceMap.get(sKey).visits += 1;
  });
  return { mediaQuality: Array.from(mediaMap.values()), webSourceQuality: Array.from(sourceMap.values()) };
}

/* ============================================================================
 * VERIFY JWT（HS256・専用署名。正本仕様§12-2）
 * ============================================================================ */

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlToBuffer(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

/** VERIFY書込み用の短命JWTを発行する（ローカル発行スクリプト専用。本番Cloud Functionsは
 * 発行せず検証のみ行う）。 */
function signVerifyJwt(secret, { sub, aud, scope, ttlSeconds = 15 * 60 }) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'aoki-tosou-funnel-verify-issuer',
    sub, aud, scope,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomBytes(16).toString('hex')
  };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return { token: signingInput + '.' + base64url(signature), jti: payload.jti, exp: payload.exp };
}

/** VERIFY書込みJWTを検証する。iss/sub/aud/scope/exp/署名の全項目を検証し、
 * 失敗理由をJTIも含めて返す（JWT本体はログへ残さない前提。呼び出し側がtoken文字列自体を
 * ログ出力しないこと）。 */
function verifyVerifyJwt(token, secret, { expectedAud, expectedScope, expectedSub }) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return { ok: false, reason: 'malformed' };
  const [headerB64, payloadB64, sigB64] = token.split('.');
  let header, payload;
  try {
    header = JSON.parse(base64urlToBuffer(headerB64).toString('utf8'));
    payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
  } catch (err) { return { ok: false, reason: 'malformed' }; }
  if (header.alg !== 'HS256') return { ok: false, reason: 'alg' };
  const signingInput = headerB64 + '.' + payloadB64;
  const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  const actualSig = base64urlToBuffer(sigB64);
  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) return { ok: false, reason: 'signature', jti: payload.jti };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'exp', jti: payload.jti };
  if (payload.aud !== expectedAud) return { ok: false, reason: 'aud', jti: payload.jti };
  if (payload.scope !== expectedScope) return { ok: false, reason: 'scope', jti: payload.jti };
  if (expectedSub && payload.sub !== expectedSub) return { ok: false, reason: 'sub', jti: payload.jti };
  return { ok: true, jti: payload.jti, sub: payload.sub };
}

module.exports = {
  EVENT_ID_PATTERN,
  VISIT_ID_PATTERN,
  MEDIA_CODE_PATTERN,
  EVENT_TYPES,
  validateCoreFields,
  normalizeMediaCode,
  normalizeWebSource,
  evaluateVisitorIdentity,
  computeVisitorHash,
  isOlderTuple,
  recordWebEventV2,
  jstDateKey,
  hashDiagnostic_,
  isNewMethodLog,
  classifyLogCategory,
  buildQualityAxes,
  signVerifyJwt,
  verifyVerifyJwt
};
