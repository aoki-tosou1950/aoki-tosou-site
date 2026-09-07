'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkExclusiveSwitch } = require('../scripts/check_analytics_exclusive_switch');

test('R9#7：全ページV1のみ → PASS（siteMode=v1）', () => {
  const records = [
    { file: 'index.html', hasV1: true, hasV2: false, hasDrainOnly: false },
    { file: 'about.html', hasV1: true, hasV2: false, hasDrainOnly: false }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, true);
  assert.equal(result.siteMode, 'v1');
  assert.deepEqual(result.violations, []);
});

test('R9#7：全ページV2のみ → PASS（siteMode=v2）', () => {
  const records = [
    { file: 'index.html', hasV1: false, hasV2: true, hasDrainOnly: false, hasEngine: true, engineIndex: 10, v2Index: 100, drainOnlyIndex: -1 },
    { file: 'about.html', hasV1: false, hasV2: true, hasDrainOnly: false, hasEngine: true, engineIndex: 10, v2Index: 100, drainOnlyIndex: -1 }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, true);
  assert.equal(result.siteMode, 'v2');
});

test('R9#7：analyticsを一切ロードしないページのみ → PASS（siteMode=none）', () => {
  const records = [
    { file: 'legal.html', hasV1: false, hasV2: false, hasDrainOnly: false }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, true);
  assert.equal(result.siteMode, 'none');
});

test('R9#7：同一ページでV1とV2を同時ロード → BLOCK', () => {
  const records = [
    { file: 'index.html', hasV1: true, hasV2: true, hasDrainOnly: false }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, false);
  assert.equal(result.violations.some(v => v.file === 'index.html' && /並行起動禁止/.test(v.reason)), true);
});

test('R9#7：一部ページがV1、一部ページがV2（サイト全体でモード不一致）→ BLOCK', () => {
  const records = [
    { file: 'index.html', hasV1: true, hasV2: false, hasDrainOnly: false },
    { file: 'about.html', hasV1: false, hasV2: true, hasDrainOnly: false, hasEngine: true, engineIndex: 10, v2Index: 100, drainOnlyIndex: -1 }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, false);
  assert.equal(result.siteMode, 'mixed');
  assert.equal(result.violations.length, 2);
});

test('R9#7：V2稼働中ページにdrain-onlyローダーが同時に載っている → BLOCK', () => {
  const records = [
    { file: 'index.html', hasV1: false, hasV2: true, hasDrainOnly: true }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, false);
  assert.equal(result.violations.some(v => /drain-onlyローダー/.test(v.reason)), true);
});

test('R9#7：V1稼働中ページにdrain-onlyローダーが載っているのは許可される（rollback直後の想定用途）', () => {
  const records = [
    { file: 'index.html', hasV1: true, hasV2: false, hasDrainOnly: true, hasEngine: true, engineIndex: 10, v2Index: -1, drainOnlyIndex: 100 }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, true);
});

test('R9再監査#2：V2フルトラッカーはロードしているが、engineの<script>タグが無い → BLOCK', () => {
  const records = [
    { file: 'index.html', hasV1: false, hasV2: true, hasDrainOnly: false, hasEngine: false, engineIndex: -1, v2Index: 100, drainOnlyIndex: -1 }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, false);
  assert.equal(result.violations.some(v => /outbox-engine\.js.*<script>タグが無い/.test(v.reason)), true);
});

test('R9再監査#2：drain-onlyローダーはロードしているが、engineの<script>タグが無い → BLOCK', () => {
  const records = [
    { file: 'index.html', hasV1: true, hasV2: false, hasDrainOnly: true, hasEngine: false, engineIndex: -1, v2Index: -1, drainOnlyIndex: 100 }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, false);
  assert.equal(result.violations.some(v => /outbox-engine\.js.*<script>タグが無い/.test(v.reason)), true);
});

test('R9再監査#2：engineの<script>タグがV2より後ろにある（順序違反） → BLOCK', () => {
  const records = [
    { file: 'index.html', hasV1: false, hasV2: true, hasDrainOnly: false, hasEngine: true, engineIndex: 200, v2Index: 100, drainOnlyIndex: -1 }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, false);
  assert.equal(result.violations.some(v => /より後に置かれている/.test(v.reason)), true);
});

test('R9再監査#2：engineがV2より前に正しく置かれている → PASS', () => {
  const records = [
    { file: 'index.html', hasV1: false, hasV2: true, hasDrainOnly: false, hasEngine: true, engineIndex: 50, v2Index: 100, drainOnlyIndex: -1 }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, true);
});

test('R9再監査#2：engineがdrain-onlyより前に正しく置かれている（V1+drain-only構成） → PASS', () => {
  const records = [
    { file: 'index.html', hasV1: true, hasV2: false, hasDrainOnly: true, hasEngine: true, engineIndex: 50, v2Index: -1, drainOnlyIndex: 100 }
  ];
  const result = checkExclusiveSwitch(records);
  assert.equal(result.ok, true);
});

test('R9#7：現行サイト全16ページの実ファイルを走査 → 現時点はsiteMode=v1でPASS（本ラウンドではPROD HTML変更を行っていないことの回帰確認）', () => {
  const { run_ } = require('../scripts/check_analytics_exclusive_switch');
  const path = require('node:path');
  const siteRoot = path.resolve(__dirname, '..', '..');
  const result = run_(siteRoot);
  assert.equal(result.ok, true);
  assert.equal(result.siteMode, 'v1');
});
