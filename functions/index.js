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
  isAuthorizedTestEvent,
  jstDateKey,
  normalizeEvent,
  normalizeSalesDays,
  periodBounds,
  shiftDateKey,
  verifyLineSignature
} = require('./lib/funnel');
const { sendAdminLinePush } = require('./lib/line');

initializeApp();
const db = getFirestore();
const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const { recordInternalMetric, recordLineEvent, recordWebEvent } = createFunnelStore(db);

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
        landing_page: event.landingPage,
        current_page: event.currentPage,
        referrer: event.referrer,
        is_test: event.isTest,
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
