'use strict';
/**
 * V1→V2 analytics 切替の実行スクリプト（独立監査再提出R9再監査対応）。
 *
 * docs/v1-v2-analytics-switch.md §2の手順を、人間が正規表現を手作業で調整する
 * ことなく確実に実行するための専用ツール。対象16ファイルを固定リストで明示し
 * （推測でHTMLを走査しない）、各ファイルで実際に置換が1件だけ発生したことを
 * 検証し、置換後に共有engineの読込順・V1/V2排他をcheck_analytics_exclusive_switch.js
 * で機械的に確認してから正常終了する。
 *
 * 置換内容：
 *   <script src="(../)?js/analytics.js" defer></script>
 *   ↓
 *   <script src="(../)?js/analytics-v2-outbox-engine.js" defer></script>
 *   <script src="(../)?js/analytics-v2.js" defer></script>
 * （相対パスprefixは元のまま保持する。engineタグが必ずv2タグより前に来る）。
 *
 * 冪等性：既にV2切替済み（analytics-v2.jsを既に参照している）ファイルはスキップし、
 * BLOCKにしない（2回実行しても安全）。V1タグが見つからない、かつV2タグも
 * 見つからないファイルがあれば、そのファイルの状態を予期しないものとしてBLOCKし、
 * 他のファイルへの書込みも一切行わない（all-or-nothing。部分的な切替状態を
 * 作らない）。
 *
 * 使い方：
 *   node functions/scripts/apply_v1_to_v2_switch.js           … 実際に書き換える
 *   node functions/scripts/apply_v1_to_v2_switch.js --dry-run … 書き換えず判定のみ表示する
 *
 * 終了コード：0=成功（切替完了・排他チェックPASS）、1=BLOCK（何も書き換えていない、
 * または排他チェックが失敗した）。
 */
const fs = require('fs');
const path = require('path');
const { checkExclusiveSwitch, analyzeFile_ } = require('./check_analytics_exclusive_switch');

const SITE_ROOT = path.resolve(__dirname, '..', '..');

// 対象16ファイル（固定リスト。推測でHTMLを走査しない）。
const TARGET_FILES = [
  'index.html', 'about.html', 'case001.html', 'case002.html', 'faq.html', 'works.html',
  'works/case001.html', 'works/case002.html', 'works/case003.html', 'works/case004.html',
  'works/case005.html', 'works/case006.html', 'works/case007.html', 'works/case008.html',
  'works/case009.html', 'works/case010.html', 'works/template.html'
];

const V1_TAG_RE = /<script src="((?:\.\.\/)?)js\/analytics\.js" defer><\/script>/;

function planFile_(relPath) {
  const fullPath = path.join(SITE_ROOT, relPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  const hasV1 = V1_TAG_RE.test(content);
  const hasV2 = /src="(?:\.\.\/)?js\/analytics-v2\.js"/.test(content);
  const hasEngine = /src="(?:\.\.\/)?js\/analytics-v2-outbox-engine\.js"/.test(content);

  if (!hasV1 && hasV2 && hasEngine) {
    return { relPath, fullPath, action: 'skip-already-switched', content };
  }
  if (!hasV1) {
    return { relPath, fullPath, action: 'error-no-v1-tag-found', content };
  }
  const match = content.match(V1_TAG_RE);
  const prefix = match[1]; // '' または '../'
  const replacement =
    '<script src="' + prefix + 'js/analytics-v2-outbox-engine.js" defer></script>\n' +
    '<script src="' + prefix + 'js/analytics-v2.js" defer></script>';
  const newContent = content.replace(V1_TAG_RE, replacement);
  // 置換が実際に1箇所だけ発生したことを確認する（複数該当・非該当はBLOCK対象）。
  const occurrences = (content.match(new RegExp(V1_TAG_RE.source, 'g')) || []).length;
  if (occurrences !== 1) {
    return { relPath, fullPath, action: 'error-unexpected-occurrence-count', occurrences, content };
  }
  return { relPath, fullPath, action: 'switch', newContent, content };
}

function run_(dryRun) {
  const plans = TARGET_FILES.map(planFile_);
  const errors = plans.filter((p) => p.action.indexOf('error-') === 0);
  if (errors.length > 0) {
    console.error('BLOCK: 以下のファイルが予期しない状態です。1件も書き換えていません。');
    errors.forEach((e) => console.error('  - ' + e.relPath + ': ' + e.action + (e.occurrences !== undefined ? ' (occurrences=' + e.occurrences + ')' : '')));
    process.exitCode = 1;
    return;
  }

  const toSwitch = plans.filter((p) => p.action === 'switch');
  const alreadySwitched = plans.filter((p) => p.action === 'skip-already-switched');

  console.log('=== 切替計画 ===');
  toSwitch.forEach((p) => console.log('  切替: ' + p.relPath));
  alreadySwitched.forEach((p) => console.log('  スキップ（既に切替済み）: ' + p.relPath));

  if (dryRun) {
    console.log('（--dry-runのため実際には書き換えていません）');
    process.exitCode = 0;
    return;
  }

  toSwitch.forEach((p) => {
    fs.writeFileSync(p.fullPath, p.newContent, 'utf8');
  });
  console.log('=== ' + toSwitch.length + '件を書き換えました ===');

  // 書き換え直後、共有engineの読込順・V1/V2排他を機械的に検証する。
  const files = TARGET_FILES.map((rel) => path.join(SITE_ROOT, rel));
  const records = files.map(analyzeFile_);
  const result = checkExclusiveSwitch(records);
  if (!result.ok) {
    console.error('BLOCK: 切替後の排他チェックが失敗しました（ファイルは書き換え済みです。手動で確認してください）。');
    result.violations.forEach((v) => console.error('  - ' + v.file + ' : ' + v.reason));
    process.exitCode = 1;
    return;
  }
  console.log('OK: check_analytics_exclusive_switch.js PASS（siteMode=' + result.siteMode + '）');
  if (result.siteMode !== 'v2') {
    console.error('BLOCK: siteModeがv2になっていません（実際: ' + result.siteMode + '）。');
    process.exitCode = 1;
    return;
  }
  console.log('=== 切替完了：全' + TARGET_FILES.length + 'ファイルがV2（engine→analytics-v2.js）を参照しています ===');
  process.exitCode = 0;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run_(dryRun);
}

module.exports = { run_, planFile_, TARGET_FILES };
