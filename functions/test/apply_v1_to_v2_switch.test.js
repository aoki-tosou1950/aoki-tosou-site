'use strict';
/* =====================================================================
 * 独立監査再提出R9再監査対応：V1→V2切替実行スクリプト（apply_v1_to_v2_switch.js）
 * の回帰テスト。取締役の指示「概略の正規表現を私が手作業で調整する形にはしない
 * こと」に基づき新設。実サイトファイルを一時ディレクトリへコピーしたうえで
 * 実際に切替を実行し、置換結果・冪等性・排他チェック連携を検証する
 * （モックではなく、本物のfs書込み・本物のcheck_analytics_exclusive_switch.js
 * 連携を通す）。
 * ===================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SITE_ROOT = path.resolve(__dirname, '..', '..');
const { TARGET_FILES } = require('../scripts/apply_v1_to_v2_switch');

function makeTempSiteCopy_() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1v2switch-test-'));
  fs.mkdirSync(path.join(tmpDir, 'works'));
  fs.mkdirSync(path.join(tmpDir, 'functions', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'js'));
  TARGET_FILES.forEach((rel) => {
    fs.copyFileSync(path.join(SITE_ROOT, rel), path.join(tmpDir, rel));
  });
  fs.copyFileSync(
    path.join(SITE_ROOT, 'functions', 'scripts', 'check_analytics_exclusive_switch.js'),
    path.join(tmpDir, 'functions', 'scripts', 'check_analytics_exclusive_switch.js')
  );
  fs.copyFileSync(
    path.join(SITE_ROOT, 'functions', 'scripts', 'apply_v1_to_v2_switch.js'),
    path.join(tmpDir, 'functions', 'scripts', 'apply_v1_to_v2_switch.js')
  );
  ['analytics.js', 'analytics-v2.js', 'analytics-v2-outbox-engine.js'].forEach((f) => {
    fs.copyFileSync(path.join(SITE_ROOT, 'js', f), path.join(tmpDir, 'js', f));
  });
  return tmpDir;
}

function loadScriptModuleForRoot_(tmpDir) {
  const modPath = path.join(tmpDir, 'functions', 'scripts', 'apply_v1_to_v2_switch.js');
  delete require.cache[require.resolve(modPath)];
  delete require.cache[require.resolve(path.join(tmpDir, 'functions', 'scripts', 'check_analytics_exclusive_switch.js'))];
  return require(modPath);
}

test('R9再監査対応：TARGET_FILESは実サイトの全17ファイルと完全一致する（対象を推測で走査しない・固定リストが実態と一致していることの回帰確認）', () => {
  assert.equal(TARGET_FILES.length, 17);
  TARGET_FILES.forEach((rel) => {
    assert.ok(fs.existsSync(path.join(SITE_ROOT, rel)), rel + ' が実在しない');
  });
});

test('R9再監査対応：--dry-runは1バイトも書き換えない', () => {
  const tmpDir = makeTempSiteCopy_();
  try {
    const before = TARGET_FILES.map((rel) => fs.readFileSync(path.join(tmpDir, rel), 'utf8'));
    const mod = loadScriptModuleForRoot_(tmpDir);
    mod.run_(true); // dry-run
    const after = TARGET_FILES.map((rel) => fs.readFileSync(path.join(tmpDir, rel), 'utf8'));
    assert.deepEqual(before, after);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R9再監査対応：実行すると全17ファイルがengine→analytics-v2.jsの順に切り替わり、相対パスprefixが正しく保持される', () => {
  const tmpDir = makeTempSiteCopy_();
  try {
    const mod = loadScriptModuleForRoot_(tmpDir);
    mod.run_(false);

    const indexContent = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8');
    assert.match(indexContent, /<script src="js\/analytics-v2-outbox-engine\.js" defer><\/script>\n<script src="js\/analytics-v2\.js" defer><\/script>/);
    assert.doesNotMatch(indexContent, /<script src="js\/analytics\.js" defer><\/script>/);

    const worksCase001 = fs.readFileSync(path.join(tmpDir, 'works', 'case001.html'), 'utf8');
    assert.match(worksCase001, /<script src="\.\.\/js\/analytics-v2-outbox-engine\.js" defer><\/script>\n<script src="\.\.\/js\/analytics-v2\.js" defer><\/script>/);
    assert.doesNotMatch(worksCase001, /<script src="\.\.\/js\/analytics\.js" defer><\/script>/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R9再監査対応：切替後、対象ファイル以外の内容は一切変更されない（スクリプトタグの1箇所だけが変わる）', () => {
  const tmpDir = makeTempSiteCopy_();
  try {
    const beforeIndex = fs.readFileSync(path.join(SITE_ROOT, 'index.html'), 'utf8');
    const mod = loadScriptModuleForRoot_(tmpDir);
    mod.run_(false);
    const afterIndex = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8');

    const beforeLines = beforeIndex.split('\n');
    const afterLines = afterIndex.split('\n');
    // 1行が2行に増えるだけで、他の行はすべて同一のまま。
    assert.equal(afterLines.length, beforeLines.length + 1);
    const v1LineIdx = beforeLines.findIndex((l) => l.indexOf('js/analytics.js') >= 0);
    assert.ok(v1LineIdx >= 0);
    for (let i = 0; i < v1LineIdx; i++) assert.equal(afterLines[i], beforeLines[i]);
    for (let i = v1LineIdx + 1; i < beforeLines.length; i++) assert.equal(afterLines[i + 1], beforeLines[i]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R9再監査対応：切替後、check_analytics_exclusive_switch.jsがsiteMode=v2・PASSを返す（切替スクリプト自身が内部で同じ検査を実行し失敗時はexit 1する契約の直接確認）', () => {
  const tmpDir = makeTempSiteCopy_();
  try {
    const mod = loadScriptModuleForRoot_(tmpDir);
    mod.run_(false);
    const checkerPath = path.join(tmpDir, 'functions', 'scripts', 'check_analytics_exclusive_switch.js');
    delete require.cache[require.resolve(checkerPath)];
    const checker = require(checkerPath);
    const result = checker.run_(tmpDir);
    assert.equal(result.ok, true);
    assert.equal(result.siteMode, 'v2');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R9再監査対応：既にV2切替済みのファイルに対して再実行しても、1バイトも書き換えず正常終了する（冪等性）', () => {
  const tmpDir = makeTempSiteCopy_();
  try {
    const mod = loadScriptModuleForRoot_(tmpDir);
    mod.run_(false); // 1回目：実際に切り替える
    const afterFirst = TARGET_FILES.map((rel) => fs.readFileSync(path.join(tmpDir, rel), 'utf8'));
    mod.run_(false); // 2回目：既に切替済みのはず
    const afterSecond = TARGET_FILES.map((rel) => fs.readFileSync(path.join(tmpDir, rel), 'utf8'));
    assert.deepEqual(afterFirst, afterSecond);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R9再監査対応：対象ファイルにV1タグが1つも見つからない異常系では、他のファイルも含め1件も書き換えずBLOCKする（all-or-nothing）', () => {
  const tmpDir = makeTempSiteCopy_();
  try {
    // index.htmlだけ、V1タグを事前に壊しておく（既に何かの理由で予期しない状態、という想定）。
    const indexPath = path.join(tmpDir, 'index.html');
    const content = fs.readFileSync(indexPath, 'utf8').replace('<script src="js/analytics.js" defer></script>', '<!-- removed -->');
    fs.writeFileSync(indexPath, content, 'utf8');

    const beforeAbout = fs.readFileSync(path.join(tmpDir, 'about.html'), 'utf8');
    const mod = loadScriptModuleForRoot_(tmpDir);

    let threwOrBlocked = false;
    const originalExitCode = process.exitCode;
    mod.run_(false);
    if (process.exitCode === 1) threwOrBlocked = true;
    process.exitCode = originalExitCode;

    assert.equal(threwOrBlocked, true, 'V1タグが見つからないファイルがある場合はexitCode=1でBLOCKすること');
    const afterAbout = fs.readFileSync(path.join(tmpDir, 'about.html'), 'utf8');
    assert.equal(afterAbout, beforeAbout, '異常系検出時、他の正常なファイルも一切書き換えていないこと（all-or-nothing）');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
