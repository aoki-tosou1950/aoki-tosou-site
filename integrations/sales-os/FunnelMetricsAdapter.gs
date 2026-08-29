/**
 * 青木塗装 集客ファネル v1 - 営業OS集計adapter
 * 個人情報は送信せず、日別件数だけをFirebaseへ同期する。
 */
var AOKI_FUNNEL_SYNC_URL = 'https://us-central1-aokitosou-miniapp.cloudfunctions.net/syncSalesFunnel';
var AOKI_FUNNEL_TOKEN_PROPERTY = 'FUNNEL_DASHBOARD_TOKEN';
var AOKI_FUNNEL_INQUIRY_SHEET = '問い合わせ台帳';
var AOKI_FUNNEL_EXCLUDED_STATUSES = ['取消', '重複'];

function aokiFunnelSyncSalesMetrics() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var token = PropertiesService.getScriptProperties().getProperty(AOKI_FUNNEL_TOKEN_PROPERTY);
    if (!token) throw new Error(AOKI_FUNNEL_TOKEN_PROPERTY + ' がScript Propertiesに設定されていません。');
    var payload = aokiFunnelBuildSalesPayload_();
    var response = UrlFetchApp.fetch(AOKI_FUNNEL_SYNC_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) throw new Error('集客ファネル同期に失敗しました。HTTP ' + code);
    console.log('集客ファネル同期完了: ' + payload.days.length + '日分');
    return JSON.parse(response.getContentText());
  } finally {
    lock.releaseLock();
  }
}

function aokiFunnelPreviewSalesMetrics() {
  return aokiFunnelBuildSalesPayload_();
}

function aokiFunnelBuildSalesPayload_() {
  var spreadsheet = SpreadsheetApp.openById('1IM6NPbuERORjO7e6CRTDcyj8qvfA90g4eXJpN7sFr8k');
  var sheet = spreadsheet.getSheetByName(AOKI_FUNNEL_INQUIRY_SHEET);
  if (!sheet) throw new Error('問い合わせ台帳がありません。');
  var values = sheet.getDataRange().getDisplayValues();
  if (values.length < 1) return { source: 'aoki-sales-os', days: [] };
  var headers = aokiFunnelHeaderMap_(values[0]);
  ['問い合わせID', '受付日', '状態', '現調実施日', '見積提出日', '成約日'].forEach(function(name) {
    if (headers[name] === undefined) throw new Error('必要なヘッダーがありません: ' + name);
  });
  var byDate = {};
  values.slice(1).forEach(function(row) {
    if (!String(row[headers['問い合わせID']] || '').trim()) return;
    var status = String(row[headers['状態']] || '').trim();
    if (AOKI_FUNNEL_EXCLUDED_STATUSES.indexOf(status) >= 0) return;
    aokiFunnelIncrement_(byDate, row[headers['受付日']], 'inquiries');
    aokiFunnelIncrement_(byDate, row[headers['現調実施日']], 'surveys');
    aokiFunnelIncrement_(byDate, row[headers['見積提出日']], 'estimates');
    aokiFunnelIncrement_(byDate, row[headers['成約日']], 'orders');
  });
  var days = Object.keys(byDate).sort().slice(-400).map(function(date) {
    return Object.assign({ date: date }, byDate[date]);
  });
  return { source: 'aoki-sales-os', generatedAt: new Date().toISOString(), days: days };
}

function aokiFunnelIncrement_(byDate, value, key) {
  var date = aokiFunnelDateKey_(value);
  if (!date) return;
  if (!byDate[date]) byDate[date] = { inquiries: 0, surveys: 0, estimates: 0, orders: 0 };
  byDate[date][key] += 1;
}

function aokiFunnelDateKey_(value) {
  var match = String(value || '').trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return '';
  var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  var date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function aokiFunnelHeaderMap_(headers) {
  var result = {};
  headers.forEach(function(value, index) {
    var name = String(value || '').trim();
    if (name) result[name] = index;
  });
  return result;
}
