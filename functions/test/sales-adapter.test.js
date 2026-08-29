'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAdapter(rows) {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'sales-os', 'FunnelMetricsAdapter.gs'), 'utf8');
  const context = {
    console,
    Date,
    SpreadsheetApp: {
      openById() {
        return {
          getSheetByName() {
            return { getDataRange() { return { getDisplayValues() { return rows; } }; } };
          }
        };
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test('営業OS adapterは日別件数だけを集計し取消・重複を除外する', () => {
  const headers = ['問い合わせID', '受付日', '状態', '現調実施日', '見積提出日', '成約日'];
  const adapter = loadAdapter([
    headers,
    ['I-1', '2026/08/01', '対応中', '2026/08/02', '2026/08/03', '2026/08/04'],
    ['I-2', '2026/08/01', '取消', '2026/08/02', '', ''],
    ['I-3', '2026-08-01', '成約', '2026-08-02', '2026-08-03', '2026-08-04']
  ]);
  const payload = adapter.aokiFunnelBuildSalesPayload_();
  const plainDays = JSON.parse(JSON.stringify(payload.days));
  assert.deepEqual(plainDays, [
    { date: '2026-08-01', inquiries: 2, surveys: 0, estimates: 0, orders: 0 },
    { date: '2026-08-02', inquiries: 0, surveys: 2, estimates: 0, orders: 0 },
    { date: '2026-08-03', inquiries: 0, surveys: 0, estimates: 2, orders: 0 },
    { date: '2026-08-04', inquiries: 0, surveys: 0, estimates: 0, orders: 2 }
  ]);
  assert.equal(JSON.stringify(payload).includes('I-1'), false);
});

test('営業OS adapterは欠損日と実在しない日付を計上しない', () => {
  const adapter = loadAdapter([]);
  assert.equal(adapter.aokiFunnelDateKey_(''), '');
  assert.equal(adapter.aokiFunnelDateKey_('2026/02/29'), '');
  assert.equal(adapter.aokiFunnelDateKey_('2026/02/28'), '2026-02-28');
  assert.equal(adapter.aokiFunnelDateKey_('2024/02/29 10:30'), '2024-02-29');
});
