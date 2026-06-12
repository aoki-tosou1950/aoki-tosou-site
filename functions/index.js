'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const axios = require('axios');

initializeApp();
const db = getFirestore();

const ALLOWED_ORIGINS = [
  'https://aoki-tosou.net',
  'https://www.aoki-tosou.net'
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return false;
  }

  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
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

exports.submitForm = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: ['LINE_ACCESS_TOKEN', 'ADMIN_LINE_USER_ID']
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
      await db.collection('submissions').add({
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
        createdAt: FieldValue.serverTimestamp()
      });

      // --- LINE Messaging API push（管理者のみ。broadcast は使用禁止）---
      const lineToken = process.env.LINE_ACCESS_TOKEN;
      const adminUserId = process.env.ADMIN_LINE_USER_ID;
      if (lineToken && adminUserId) {
        const lineMessage =
          `【お問い合わせ受信】\n` +
          `■ 名前: ${trimmedName}\n` +
          `■ 住所: ${trimmedAddress}\n` +
          `■ 電話: ${trimmedPhone}\n` +
          `■ 日時: ${optionalString(datetime, 200) || 'なし'}\n` +
          `■ メッセージ: ${trimmedMessage || 'なし'}`;

        await axios.post(
          'https://api.line.me/v2/bot/message/push',
          { to: adminUserId, messages: [{ type: 'text', text: lineMessage }] },
          {
            headers: {
              Authorization: `Bearer ${lineToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
      } else {
        console.warn('submitForm: LINE notification skipped — LINE_ACCESS_TOKEN or ADMIN_LINE_USER_ID not set');
      }

      return res.status(200).json({ success: true, message: 'お問い合わせを受け付けました。' });
    } catch (err) {
      console.error('submitForm error:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

exports.logInteraction = onRequest(
  {
    region: 'us-central1',
    cors: false
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

    const {
      event_type: eventType,
      contact_channel: contactChannel,
      source,
      landing_page: landingPage,
      current_page: currentPage,
      referrer
    } = body || {};

    const trimmedEventType = optionalString(eventType, 50);
    if (!trimmedEventType) {
      return res.status(400).json({ error: 'event_type is required' });
    }

    try {
      await db.collection('interaction_logs').add({
        event_type: trimmedEventType,
        contact_channel: optionalString(contactChannel, 30),
        source: optionalString(source, 100) || '不明',
        landing_page: optionalString(landingPage, 500),
        current_page: optionalString(currentPage, 500),
        referrer: optionalString(referrer, 500),
        created_at: FieldValue.serverTimestamp()
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('logInteraction error:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);
