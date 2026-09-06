'use strict';

/**
 * Web流入媒体識別精度改善・単位EF（2026-09-07・ローカル実装検証・監査差し戻し対応版）。
 * 既存V1（functions/lib/funnel.js）は無変更のまま、V2の新規ロジックをこの独立モジュールへ
 * 実装する。funnel_daily互換のためのV1由来ヘルパー（visitorDayHash_/sourceKeyV1Compat_/
 * normalizeLabelV1Compat_）は、V1（functions/lib/funnel.js）の現行実装をREAD ONLYで直接
 * 再確認したうえで、値が一致するように意図的に複製している（V1コードのrequireはしない＝
 * V1の挙動を一切変えないため独立実装のまま維持するが、アルゴリズムはV1と同一にする）。
 *
 * 本ファイルはローカルworktree（feature/funnel-media-precision-v1-ef）上での実装であり、
 * 現時点でPRODUCTIONへdeployされていない。functions/index.jsへの配線は未実施。
 */

const crypto = require('crypto');

const JST_TIME_ZONE = 'Asia/Tokyo';

/* ============================================================================
 * 検証・正規化（監査差し戻し #7：暗黙のString/Number変換で不正型を受理しない）
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
 * 監査差し戻し#7：型を暗黙変換せず、typeof自体を検証してから形式検証する
 * （数値のevent_id・文字列のoccurredAt等を誤って受理しない）。
 * 戻り値: { ok:true, core:{...} } または { ok:false, error:'...' }
 */
function validateCoreFields(body, now) {
  if (!isPlainObject(body)) return { ok: false, error: 'Invalid JSON body' };
  if (body.schemaVersion !== 2) return { ok: false, error: 'schemaVersion must be 2' };

  if (typeof body.event_id !== 'string') return { ok: false, error: 'event_id must be a string' };
  if (!EVENT_ID_PATTERN.test(body.event_id)) return { ok: false, error: 'Invalid event_id' };

  // visit_idは欠損・不正いずれも400拒否（V2 writerは厳格。legacy受理はV1 writerのみ）。
  if (typeof body.visit_id !== 'string') return { ok: false, error: 'visit_id must be a string' };
  if (!VISIT_ID_PATTERN.test(body.visit_id)) return { ok: false, error: 'Invalid visit_id' };

  if (typeof body.occurredAt !== 'number' || !Number.isInteger(body.occurredAt)) {
    return { ok: false, error: 'occurredAt must be an integer number' };
  }
  const occurredAt = body.occurredAt;
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  if (occurredAt > nowMs + OCCURRED_AT_FUTURE_TOLERANCE_MS) return { ok: false, error: 'occurredAt is too far in the future' };
  if (occurredAt < nowMs - OCCURRED_AT_PAST_TOLERANCE_MS) return { ok: false, error: 'occurredAt is too far in the past' };

  if (typeof body.eventType !== 'string' || EVENT_TYPES.indexOf(body.eventType) < 0) {
    return { ok: false, error: 'Invalid eventType' };
  }

  return { ok: true, core: { eventId: body.event_id, visitId: body.visit_id, occurredAt, eventType: body.eventType } };
}

/** mediaCode（visitMediaCode）の検証。中核フィールドとは異なりソフト縮退のみ（400にしない）。
 * 戻り値: { mediaCode, mediaValidity } — mediaValidity: 'valid'|'invalid'|'none' */
function normalizeMediaCode(rawVisitMediaCode) {
  const code = String(rawVisitMediaCode == null ? '' : rawVisitMediaCode).trim();
  if (!code) return { mediaCode: '', mediaValidity: 'none' };
  if (!MEDIA_CODE_PATTERN.test(code)) return { mediaCode: '', mediaValidity: 'invalid', invalidMediaCodeHash: hashDiagnostic_(code) };
  return { mediaCode: code, mediaValidity: 'valid' };
}

/**
 * webSource（visitWebSource）の検証（監査差し戻し#7で強化）。
 * - 'direct'判定は小文字化した後に行う（大文字表記のDirect等も正しく判定する）。
 * - ホスト名は「.」区切りの各ラベルが英数字で始まり英数字で終わる（1から63文字、内部のみ
 *   ハイフン可）ことを要求する。連続ドット・先頭/末尾ドット・先頭/末尾ハイフンはこの
 *   ラベル単位の正規表現で自然に拒否される（空ラベルや不正な先頭/末尾文字は非一致になる）。
 * 戻り値: { webSource, webSourceStatus } — webSourceStatus: 'referrer'|'direct'|'none'|'invalid'
 */
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
function isValidHostname_(lower) {
  if (!lower || lower.length > 253) return false;
  const labels = lower.split('.');
  if (labels.length < 1) return false;
  return labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label));
}
function normalizeWebSource(rawVisitWebSource) {
  const value = String(rawVisitWebSource == null ? '' : rawVisitWebSource).trim();
  if (value === '') return { webSource: '', webSourceStatus: 'none' };
  const lower = value.toLowerCase();
  if (lower === 'direct') return { webSource: 'direct', webSourceStatus: 'direct' };
  if (isValidHostname_(lower)) return { webSource: lower, webSourceStatus: 'referrer' };
  return { webSource: '', webSourceStatus: 'invalid', invalidWebSourceHash: hashDiagnostic_(value) };
}

/** 不正値の診断ハッシュ（生値は一切保持しない）。 */
function hashDiagnostic_(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** visitorId／visitorIdPersistedの全組合せ判定（正本仕様§7-1）。
 * 欠損・型不正のvisitorIdPersistedも受理する。 */
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

/** V2独自のvisitor_hash（interaction_logs.visitor_hashへ保存、日をまたぐ再訪判定用）。
 * V1のvisitorToken()と同一アルゴリズム（sha256を10文字に切り詰め）だが、V1コードには
 * 依存しない独立実装。 */
function computeVisitorHash(visitorId) {
  return crypto.createHash('sha256').update(String(visitorId)).digest('hex').slice(0, 10);
}

/* ============================================================================
 * V1互換ヘルパー（監査差し戻し#3）
 * 以下は functions/lib/funnel.js の現行実装（2026-09-07・本セッション内でREAD ONLY
 * 再確認済み：jstDateKey/normalizeLabel/sourceKey/visitorHash/createFunnelStore内の
 * recordWebEvent）と、アルゴリズム・出力値が一致するよう意図的に複製したものである。
 * V1コード自体はrequireしない（V1の挙動を変更しないため独立ファイルのまま維持する）。
 * ============================================================================ */

/** V1のjstDateKeyと同一実装。 */
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

// ASCII制御文字（コード0-31、および127）を除去する正規表現。文字コード番号から
// String.fromCharCodeで動的に構築する（ソースコード中にリテラルの制御文字エスケープを
// 書くと、保存経路の途中でエスケープ列が実際の制御バイトへ展開されファイルが破損した
// ため＝2026-09-07に発見・修正。今後もこのファイルへ\u00XX等のエスケープを直接書かない）。
const CONTROL_CHAR_PATTERN = (function buildControlCharPattern() {
  let chars = '';
  for (let i = 0; i <= 31; i++) chars += String.fromCharCode(i);
  chars += String.fromCharCode(127);
  return new RegExp('[' + chars + ']', 'g');
})();

/** V1のnormalizeLabelと同一実装（funnel_daily.sourcesのlabel正規化に使う）。
 * ASCII制御文字を除去し100文字へ切り詰める。 */
function normalizeLabelV1Compat_(value, fallback = '不明') {
  const text = String(value || '').trim().replace(CONTROL_CHAR_PATTERN, '').slice(0, 100);
  return text || fallback;
}

/** V1のsourceKeyと同一実装（sha256(normalizeLabel(label)).slice(0,16)）。 */
function sourceKeyV1Compat_(label) {
  return crypto.createHash('sha256').update(normalizeLabelV1Compat_(label)).digest('hex').slice(0, 16);
}

/** V1のvisitorHash(day, visitorId)と同一実装。funnel_dailyの日次ユニーク訪問者判定
 * （dayRef.collection('visitors').doc(...)）にのみ使う一方向ハッシュで、interaction_logsの
 * visitor_hash（computeVisitorHash、日をまたがない再訪判定用）とは別物。 */
function visitorDayHash_(day, rawVisitorId) {
  return crypto.createHash('sha256').update(`${day}:${rawVisitorId}`).digest('hex');
}

/**
 * V2の event.mediaCode / event.webSource / event.webSourceStatus から、V1の自由記述
 * source相当のラベルを導出する（funnel_daily.sourcesの内訳に使うためだけの変換）。
 * V1のfunnel.js内コメント（「fromパラメータの生値をsourceが吸収して兼用していた」）が
 * 示すとおり、歴史的にmediaCode相当の値がsourceへ入っていたため、mediaCode優先の
 * 導出は恣意的な新規ルールではなくV1の実挙動に基づく。
 */
function deriveV1CompatSourceLabel_(event) {
  if (event.mediaValidity === 'valid' && event.mediaCode) return event.mediaCode;
  if (event.webSourceStatus === 'referrer' && event.webSource) return event.webSource;
  if (event.webSourceStatus === 'direct') return 'direct';
  return '不明';
}

/* ============================================================================
 * 冪等Transaction契約（正本仕様§9、監査差し戻し#3・#8で修正）
 * ============================================================================ */

/**
 * (occurredAt, event_id) のタプル比較。aがbより古ければ true。
 * event_idは文字列昇順のみをtie-breakerとする。
 */
function isOlderTuple(a, b) {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt;
  return a.eventId < b.eventId;
}

/**
 * schemaVersion:2イベントを原子的に記録する。
 *
 * funnel_daily（監査差し戻し#3で修正）：V1の`recordWebEvent`（functions/lib/funnel.js、
 * 本セッション内でREAD ONLY再確認済み）をアルゴリズムレベルで複製する。
 *   - metrics[counter]・testMetrics[counter]をイベント種別ごとに加算（V1と同一）。
 *   - visitorsは「日付＋生visitorId」のユニーク判定（V1のvisitorHash(day,rawVisitorId)と
 *     同一の一方向ハッシュをドキュメントIDとするサブコレクション`funnel_daily/{day}/visitors`）
 *     の初回到達時にだけ加算する。生visitorIdはこの判定にのみ使い、Firestoreへは保存しない。
 *   - sources/testSourcesは、V1のsourceKey(label)と同一アルゴリズムで求めたキーへ
 *     {label, visitors, pageViews, lineClicks}を集計する（V1と同様、lineClicksのみを
 *     ソース別に記録し、phoneClicksはソース別には記録しない＝V1の既知の仕様をそのまま複製、
 *     改善ではなく互換を優先する）。
 *
 * visit_sessionsの媒体帰属正本7項目は最小(occurredAt,event_id)のイベントを正本とし、
 * より古いイベント後着時だけ7項目一括更新。それ以外でmediaCode/webSource/mediaValidity/
 * webSourceStatusのいずれかが異なる場合はattributionMismatch=trueのみ立てる
 * （監査差し戻し#8：statusも比較対象に含める）。
 *
 * hash_reliable（監査差し戻し#4）：writerがraw logへ`hash_reliable`という保存フィールド名で
 * 明示的に保存する。classifyLogCategoryはこの同じフィールド名を読む。
 *
 * @param {object} db Firestore（本番） or 隔離Firestore（VERIFY）
 * @param {object} collections {interactionLogs, funnelDaily, visitSessions} コレクション名
 * @param {object} event { eventId, visitId, occurredAt, eventType, mediaCode, mediaValidity,
 *   webSource, webSourceStatus, visitorHash, hashReliable, visitorIdStatus, rawVisitorId,
 *   contactChannel, currentPage, landingPage, referrerHost, isTest, invalidMediaCodeHash,
 *   invalidWebSourceHash }
 *   rawVisitorId: V1互換の日次ユニーク訪問者判定にのみ使う一時値。Firestoreへは書き込まない。
 * @param {Date} now transaction実行時刻（funnel_dailyの日付＝処理時刻基準、V1と同一規則）
 */
async function recordWebEventV2(db, collections, event, now = new Date()) {
  const rawLogRef = db.collection(collections.interactionLogs).doc(event.eventId);
  const day = jstDateKey(now); // V1互換：処理時刻基準
  const dayRef = db.collection(collections.funnelDaily).doc(day);
  const visitSessionRef = db.collection(collections.visitSessions).doc(event.visitId);
  const rawVisitorId = event.rawVisitorId || '';
  const dailyVisitorRef = event.eventType === 'page_view'
    ? dayRef.collection('visitors').doc(visitorDayHash_(day, event.isTest ? `test:${rawVisitorId}` : rawVisitorId))
    : null;

  return db.runTransaction(async (transaction) => {
    const rawLogSnapshot = await transaction.get(rawLogRef);
    if (rawLogSnapshot.exists) {
      // transactionの原子性により、存在する時点で当時のtransaction全体（raw log＋
      // funnel_daily＋visit_sessions）が完了済みであることが構造的に保証される。
      return { recorded: false, duplicate: true };
    }

    // 監査差し戻し「Emulator READ ONLY確認」で発見：実Firestoreは「transaction内の全read完了後
    // でなければwriteできない」制約を強制する（fakeFirestoreV2の簡易モックはこれを検知できず、
    // 単体テストでは見つからなかった）。visitSessionSnapshotの読取りをここで（dailyVisitorRefの
    // transaction.create書込みより前に）まとめて行い、以降は一切readを行わない構造へ修正した。
    const daySnapshot = await transaction.get(dayRef);
    const visitorSnapshot = dailyVisitorRef ? await transaction.get(dailyVisitorRef) : null;
    const visitSessionSnapshot = await transaction.get(visitSessionRef);
    const dayData = daySnapshot.exists ? daySnapshot.data() : {};
    const daily = {
      date: day,
      metrics: Object.assign({}, dayData.metrics || {}),
      testMetrics: Object.assign({}, dayData.testMetrics || {}),
      sources: Object.assign({}, dayData.sources || {}),
      testSources: Object.assign({}, dayData.testSources || {})
    };

    const counterByEventType = { page_view: 'pageViews', line_click: 'lineClicks', phone_click: 'phoneClicks' };
    const counter = counterByEventType[event.eventType];
    const sourceLabel = deriveV1CompatSourceLabel_(event);
    const sKey = sourceKeyV1Compat_(sourceLabel);
    const source = Object.assign({ label: sourceLabel, visitors: 0, pageViews: 0, lineClicks: 0 }, daily.sources[sKey] || {});
    const testSource = Object.assign({ label: sourceLabel, visitors: 0, pageViews: 0, lineClicks: 0 }, daily.testSources[sKey] || {});

    if (counter) daily.metrics[counter] = Number(daily.metrics[counter] || 0) + 1;
    if (event.isTest && counter) daily.testMetrics[counter] = Number(daily.testMetrics[counter] || 0) + 1;
    // V1と同一：ソース別内訳はpage_view→pageViews、line_click→lineClicksのみ加算する
    // （phone_clickはソース別内訳を持たない。V1の既知の仕様をそのまま複製）。
    if (event.eventType === 'page_view') source.pageViews += 1;
    if (event.eventType === 'line_click') source.lineClicks += 1;
    if (event.isTest && event.eventType === 'page_view') testSource.pageViews += 1;
    if (event.isTest && event.eventType === 'line_click') testSource.lineClicks += 1;

    if (dailyVisitorRef && !visitorSnapshot.exists) {
      daily.metrics.visitors = Number(daily.metrics.visitors || 0) + 1;
      source.visitors += 1;
      if (event.isTest) {
        daily.testMetrics.visitors = Number(daily.testMetrics.visitors || 0) + 1;
        testSource.visitors += 1;
      }
      transaction.create(dailyVisitorRef, { isTest: Boolean(event.isTest), createdAt: now });
    }
    daily.sources[sKey] = source;
    if (event.isTest) daily.testSources[sKey] = testSource;

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
      } else if (
        existing.mediaCode !== event.mediaCode || existing.webSource !== event.webSource ||
        existing.mediaValidity !== event.mediaValidity || existing.webSourceStatus !== event.webSourceStatus
      ) {
        // 監査差し戻し#8：mediaCode/webSourceの値だけでなくmediaValidity/webSourceStatusも
        // 一致しなければattributionMismatchとする（同じ文字列でも状態が異なれば不一致扱い）。
        update.attributionMismatch = true;
      }
      if (event.eventType === 'page_view' && !existing.hasPageView) update.hasPageView = true;
      if (Object.keys(update).length) visitSessionWrite = update;
    }

    transaction.set(rawLogRef, {
      event_type: event.eventType,
      contact_channel: event.contactChannel || '',
      from: event.mediaCode || '',
      media_validity: event.mediaValidity,
      web_source: event.webSource || '',
      web_source_status: event.webSourceStatus,
      landing_page: event.landingPage || '',
      current_page: event.currentPage || '',
      referrer_host: event.referrerHost || '', // 正規化済みホストのみ（完全URLは保存しない）
      is_test: Boolean(event.isTest),
      visitor_hash: event.visitorHash || '',
      hash_reliable: Boolean(event.hashReliable), // 監査差し戻し#4：明示保存フィールド名
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
 * legacy/新方式 4分類（正本仕様§7、監査差し戻し#4で読取フィールド名を修正）
 * ============================================================================ */

/** visit_idの有無・形式検証結果だけを正とする（日付は使わない）。 */
function isNewMethodLog(visitIdRaw) {
  return VISIT_ID_PATTERN.test(String(visitIdRaw || ''));
}

/**
 * 1件のraw log（interaction_logsドキュメント相当）を4区分へ分類する。
 * 監査差し戻し#4：`row.hashReliable`（手作りfixtureのcamelCase）ではなく、
 * writerが実際に保存するフィールド名`row.hash_reliable`を読む。
 * legacyの「信頼できる」は事後証明できないため常にlegacy_unknownとする（1区分目）。
 */
function classifyLogCategory(row) {
  const isNewMethod = isNewMethodLog(row.visit_id);
  const hashPresent = Boolean(row.visitor_hash);
  if (!isNewMethod) {
    return hashPresent ? 'legacy_unknown' : 'legacy_hash_missing';
  }
  return row.hash_reliable ? 'new_reliable' : 'new_unreliable';
}

/**
 * visit_sessionsの一覧から、媒体軸(mediaQuality)・Web参照元軸(webSourceQuality)を
 * 独立に集計する（正本仕様§8-2、監査差し戻し#5で修正）。
 * - hasPageView===trueのsessionだけをvisitsへ計上する（reaction-onlyのsessionは
 *   訪問数に混ぜない。単位C相当の既存原則をV2でも維持する）。
 * - Web軸キーは統合仕様どおり source:referrer:<hostname> / source:direct / source:none /
 *   source:invalid の4形式へ統一する。
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
    if (v.webSourceStatus === 'referrer') return 'source:referrer:' + v.webSource;
    if (v.webSourceStatus === 'direct') return 'source:direct';
    if (v.webSourceStatus === 'invalid') return 'source:invalid';
    return 'source:none';
  }
  visitSessions
    .filter((v) => v.hasPageView === true) // 監査差し戻し#5：reaction-only sessionを除外
    .forEach((v) => {
      const mKey = mediaKeyOf(v);
      if (mKey) {
        if (!mediaMap.has(mKey)) mediaMap.set(mKey, { key: mKey, mediaCode: v.mediaValidity === 'invalid' ? '' : v.mediaCode, mediaValidity: v.mediaValidity, visits: 0 });
        mediaMap.get(mKey).visits += 1;
      }
      const sKey = sourceKeyOf(v);
      if (!sourceMap.has(sKey)) sourceMap.set(sKey, { key: sKey, webSource: v.webSource, webSourceStatus: v.webSourceStatus, visits: 0 });
      sourceMap.get(sKey).visits += 1;
    });
  return { mediaQuality: Array.from(mediaMap.values()), webSourceQuality: Array.from(sourceMap.values()) };
}

/* ============================================================================
 * VERIFY JWT（HS256・専用署名。正本仕様§12-2、監査差し戻し#6で修正）
 * ============================================================================ */

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlToBuffer(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

const VERIFY_JWT_ISSUER = 'aoki-tosou-funnel-verify-issuer';

/** VERIFY書込み用の短命JWTを発行する（ローカル発行スクリプト専用。本番Cloud Functionsは
 * 発行せず検証のみ行う）。 */
function signVerifyJwt(secret, { sub, aud, scope, ttlSeconds = 15 * 60 }) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: VERIFY_JWT_ISSUER,
    sub, aud, scope,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomBytes(16).toString('hex')
  };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return { token: signingInput + '.' + base64url(signature), jti: payload.jti, exp: payload.exp };
}

/**
 * VERIFY書込みJWTを検証する（監査差し戻し#6で修正）。
 * - 署名確認が完了するまでpayloadのいかなるクレーム（jti含む）も戻り値へ含めない
 *   （署名不正payload由来のjtiを返さない・監査ログへ残さない）。
 * - 署名確認後にのみ iss/sub/aud/scope/exp を全て検証する。
 */
function verifyVerifyJwt(token, secret, { expectedAud, expectedScope, expectedSub, expectedIss = VERIFY_JWT_ISSUER }) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return { ok: false, reason: 'malformed' };
  const [headerB64, payloadB64, sigB64] = token.split('.');
  let header;
  try {
    header = JSON.parse(base64urlToBuffer(headerB64).toString('utf8'));
  } catch (err) { return { ok: false, reason: 'malformed' }; }
  if (header.alg !== 'HS256') return { ok: false, reason: 'alg' };

  // --- 署名検証（この時点まではpayloadの中身を一切信用・返却しない） ---
  const signingInput = headerB64 + '.' + payloadB64;
  const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  let actualSig;
  try { actualSig = base64urlToBuffer(sigB64); } catch (err) { return { ok: false, reason: 'malformed' }; }
  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: 'signature' }; // jtiを含めない（未検証payload由来のため）
  }

  // --- 署名確認後にのみpayloadをパースしてクレームを検証する ---
  let payload;
  try {
    payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
  } catch (err) { return { ok: false, reason: 'malformed' }; }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== expectedIss) return { ok: false, reason: 'iss', jti: payload.jti };
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
  VERIFY_JWT_ISSUER,
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
  verifyVerifyJwt,
  // V1互換ヘルパー（契約テストで直接比較するためexportする）
  visitorDayHash_,
  sourceKeyV1Compat_,
  normalizeLabelV1Compat_,
  deriveV1CompatSourceLabel_
};
