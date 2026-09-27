'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaLabelResolver, DEADLINE_MS } = require('../lib/media-labels');

test('production deadline allows a scale-to-zero cold start without minimum instances', () => {
  assert.equal(DEADLINE_MS, 5000);
});

test('registered, unknown and missing media; one fetch per cache window', async () => {
  let count = 0;
  let now = 1000;
  const display = createMediaLabelResolver({
    now: () => now,
    cacheMs: 1000,
    loadLabels: async () => {
      count++;
      return {
        meishi: '既存名刺QR（meishi）',
        area_check_v1: 'エリア点検チラシ 劣化住宅地・他社周辺 v1'
      };
    }
  });
  assert.equal(await display('meishi'), '既存名刺QR（meishi）');
  assert.equal(await display('area_check_v1'), 'エリア点検チラシ 劣化住宅地・他社周辺 v1');
  assert.equal(await display('new_flyer'), '未登録の媒体（new_flyer）');
  assert.equal(await display(''), '直接・不明');
  assert.equal(await display('direct'), '直接・不明');
  assert.equal(count, 1);
  now += 1001;
  assert.equal(await display('meishi'), '既存名刺QR（meishi）');
  assert.equal(count, 2);
});

test('network/auth failure and deadline keep raw code; failure cooldown', async () => {
  let count = 0;
  const error = createMediaLabelResolver({
    loadLabels: async () => { count++; throw new Error('permission denied'); }
  });
  assert.equal(await error('meishi'), 'meishi');
  assert.equal(await error('meishi'), 'meishi');
  assert.equal(count, 1);
  const timeout = createMediaLabelResolver({
    deadlineMs: 15,
    loadLabels: () => new Promise(() => {})
  });
  const start = Date.now();
  assert.equal(await timeout('area_check_v1'), 'area_check_v1');
  assert.ok(Date.now() - start < 200);
});

test('invalid labels fail closed to raw code', async () => {
  const display = createMediaLabelResolver({
    loadLabels: async () => ({ meishi: '表示名\n偽装: yes' })
  });
  assert.equal(await display('meishi'), 'meishi');
});
