'use strict';

const LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

function safeErrorSummary(error) {
  return {
    status: error && error.response && Number(error.response.status) || null,
    code: error && error.code ? String(error.code).slice(0, 50) : null,
    message: error && error.message ? String(error.message).slice(0, 200) : 'unknown error'
  };
}

function formatMediaSource(source) {
  const code = typeof source === 'string' ? source.trim() : '';
  return /^[A-Za-z0-9_-]{1,50}$/.test(code) && code.toLowerCase() !== 'direct'
    ? code : '直接・不明';
}

function formatFormAdminMessage({ name, address, phone, datetime, message, source, mediaLabel }) {
  return `【お問い合わせ受信】\n` +
    `■ 媒体: ${mediaLabel || formatMediaSource(source)}\n` +
    `■ 名前: ${name}\n` +
    `■ 住所: ${address}\n` +
    `■ 電話: ${phone}\n` +
    `■ 日時: ${datetime || 'なし'}\n` +
    `■ メッセージ: ${message || 'なし'}`;
}

function formatOtherAdminMessage(data, mediaLabel) {
  const worksText = data.works.length > 0 ? data.works.join('・') : 'なし';
  const datesText =
    `第1希望: ${data.date1 || '-'} ${data.time1 || '-'}\n` +
    `第2希望: ${data.date2 || '-'} ${data.time2 || '-'}\n` +
    `第3希望: ${data.date3 || '-'} ${data.time3 || '-'}`;
  return `【その他のご依頼】\n\n` +
    `媒体: ${mediaLabel || formatMediaSource(data.source)}\n` +
    `名前: ${data.name}\n` +
    `住所: ${data.city || 'なし'}\n` +
    `依頼内容: ${worksText}\n` +
    `${datesText}\n` +
    `備考: ${data.detail || 'なし'}`;
}

async function sendAdminLinePush(httpClient, options, logger = console) {
  const context = String(options && options.context || 'LINE notification').slice(0, 80);
  const token = options && options.token;
  const to = options && options.to;
  const messages = options && options.messages;
  if (!token || !to) {
    logger.warn(`${context}: LINE notification skipped — required Secret not set`);
    return { sent: false, skipped: true };
  }

  try {
    await httpClient.post(
      LINE_PUSH_ENDPOINT,
      { to, messages },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      }
    );
    return { sent: true };
  } catch (error) {
    // Axios error全体にはAuthorizationや本文（PII）が含まれ得るため出力しない。
    logger.error(`${context}: LINE push failed (Firestore save succeeded):`, safeErrorSummary(error));
    return { sent: false, skipped: false };
  }
}

module.exports = {
  LINE_PUSH_ENDPOINT,
  safeErrorSummary,
  formatMediaSource,
  formatFormAdminMessage,
  formatOtherAdminMessage,
  sendAdminLinePush
};
