'use strict';

const http = require('node:http');
const { GoogleAuth } = require('google-auth-library');

const SHEET = '媒体コードマスタ';
const READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const CODE_RE = /^[A-Za-z0-9_-]{1,50}$/;

async function readMediaLabels({ spreadsheetId, auth, fetcher = fetch }) {
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required');
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Could not get read-only access token');
  const ranges = ['B1:B200', 'C1:C200', 'H1:H200'];
  const query = ranges.map(r => 'ranges=' + encodeURIComponent("'" + SHEET + "'!" + r)).join('&');
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
    encodeURIComponent(spreadsheetId) + '/values:batchGet?' + query;
  const response = await fetcher(url, {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error('Sheet read failed: ' + response.status);
  const body = await response.json();
  const columns = (body.valueRanges || []).map(v => v.values || []);
  if (columns.length !== 3 ||
      columns[0][0]?.[0] !== '表示名' ||
      columns[1][0]?.[0] !== '使用中' ||
      columns[2][0]?.[0] !== 'fromコード') {
    throw new Error('Media master columns changed');
  }

  const labels = Object.create(null);
  for (let i = 1; i < columns[2].length; i++) {
    const code = String(columns[2][i]?.[0] || '').trim();
    const label = String(columns[0][i]?.[0] || '').trim();
    const active = String(columns[1][i]?.[0] || '').trim();
    if (active !== 'はい' || !CODE_RE.test(code) ||
        !label || label.length > 80 || /[\r\n]/.test(label)) continue;
    if (Object.hasOwn(labels, code)) throw new Error('Duplicate from code');
    labels[code] = label;
  }
  return labels;
}

function createHandler(readLabels) {
  return async (req, res) => {
    if (req.url !== '/media-labels') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    try {
      const labels = await readLabels();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=300'
      }).end(JSON.stringify({ labels }));
    } catch (_error) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'media labels unavailable' }));
    }
  };
}

if (require.main === module) {
  const auth = new GoogleAuth({ scopes: [READ_SCOPE] });
  http.createServer(createHandler(() => readMediaLabels({
    spreadsheetId: process.env.SPREADSHEET_ID,
    auth
  }))).listen(Number(process.env.PORT) || 8080);
}

module.exports = { READ_SCOPE, readMediaLabels, createHandler };