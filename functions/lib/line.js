'use strict';

const LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

function safeErrorSummary(error) {
  return {
    status: error && error.response && Number(error.response.status) || null,
    code: error && error.code ? String(error.code).slice(0, 50) : null,
    message: error && error.message ? String(error.message).slice(0, 200) : 'unknown error'
  };
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
  sendAdminLinePush
};
