'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'));
const port = Number(process.argv[2] || 8765);
const payload = {
  period: { start: '2026-08-01', end: '2026-08-29' },
  generatedAt: '2026-08-29T03:00:00.000Z',
  metrics: { visitors: 320, pageViews: 611, lineClicks: 24, phoneClicks: 8, inquirySubmits: 3, lineFollows: 11, lineUnfollows: 1, inquiries: 6, surveys: 5, estimates: 4, orders: 2 },
  stages: [
    ['visitors', 'サイト訪問', 320, null], ['lineClicks', 'LINEクリック', 24, 7.5], ['lineFollows', 'LINE新規友だち', 11, 45.8],
    ['inquiries', '問い合わせ', 6, 54.5], ['surveys', '現調', 5, 83.3], ['estimates', '見積', 4, 80], ['orders', '受注', 2, 50]
  ].map(function(row) { return { key: row[0], label: row[1], value: row[2], conversionRate: row[3] }; }),
  topSources: [{ source: 'Google検索', visitors: 120 }, { source: 'flyer_general_v1', visitors: 73 }, { source: 'direct', visitors: 58 }],
  lineInsight: { available: true, date: '20260828', followersCumulative: 142, blocks: 17, targetedReaches: 109, currentFriends: null }
};
http.createServer(function(req, res) {
  if (req.url.indexOf('/getFunnelDashboard') === 0) {
    if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); return res.end('{"error":"Unauthorized"}'); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(payload));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
}).listen(port, '127.0.0.1', function() { console.log('dashboard test server: http://127.0.0.1:' + port + '/funnelDashboard'); });
