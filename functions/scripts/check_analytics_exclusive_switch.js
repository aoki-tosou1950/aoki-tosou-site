'use strict';
/**
 * V1/V2 analytics 排他切替の自動検査（独立監査再提出R9・項目7で新設）。
 *
 * 【確定契約】
 * V1（js/analytics.js）とV2（js/analytics-v2.js）は排他的切替とする。
 * 並行起動は禁止＝サイトの同一HTMLページが、V1のフルトラッカーとV2のフル
 * トラッカーを同時にロードしてはならない。
 *
 * 【このスクリプトが検査すること】
 * 1. サイト配下の全HTMLページを走査し、各ページが
 *    js/analytics.js（V1） と js/analytics-v2.js（V2） の
 *    どちらか一方だけを参照している（両方は不可）ことを確認する。
 *    js/analytics-v2-drain-only.js（drain-onlyローダー）はV2の
 *    フルトラッカーではないため、この排他制約の対象外とする（後述）。
 * 2. サイト全体として、全ページが同じモード（全ページV1 or 全ページV2）で
 *    揃っていることを確認する（一部だけV1・一部だけV2という中途半端な
 *    切替状態を検出してBLOCKする）。
 * 3. drain-onlyローダー（analytics-v2-drain-only.js）が、V2フルトラッカー
 *    （analytics-v2.js）と同一ページに同時に存在する場合はBLOCKする
 *    （drain-onlyはV1稼働中ページ専用。V2稼働中ページに追加で載せる
 *    意味がない＝設計上の取り違え・二重ロードを検出する）。
 * 4. R9再監査対応・項目2で新設：analytics-v2.js／analytics-v2-drain-only.jsは
 *    js/analytics-v2-outbox-engine.js（outbox＋PROD 401サーキットブレーカーの
 *    共有エンジン）に実行時依存する（window.__aokiAnalyticsV2OutboxEngineFactory_が
 *    未定義だと即座に例外→フェイルソフトで機能が丸ごと動かない）。V2フル
 *    トラッカーまたはdrain-onlyローダーを読み込むページでは、
 *    analytics-v2-outbox-engine.jsの<script>タグが必ず存在し、かつそれより
 *    「前」に置かれていることを検査する（後ろだと未定義のままV2/drain-only
 *    本体が実行されてしまう）。
 *
 * 【使い方】
 *   node functions/scripts/check_analytics_exclusive_switch.js [siteRoot]
 * siteRootを省略した場合はこのファイルから見たリポジトリルート
 * （functions/scriptsの2階層上）を対象にする。
 *
 * 終了コード: 0=PASS（全ページ排他条件を満たす）、1=BLOCK（違反を検出）。
 * これは実際のPROD切替を行わない（ファイルを書き換えない・読むだけ）。
 * predeploy_check_dataenv.js と同様、CIやデプロイ前ゲートに組み込むための
 * 静的検査専用スクリプトである。
 */
const fs = require('fs');
const path = require('path');

const V1_PATTERN = /src=["'](?:\.\.\/)*js\/analytics\.js["']/;
const V2_PATTERN = /src=["'](?:\.\.\/)*js\/analytics-v2\.js["']/;
const DRAIN_ONLY_PATTERN = /src=["'](?:\.\.\/)*js\/analytics-v2-drain-only\.js["']/;
const ENGINE_PATTERN = /src=["'](?:\.\.\/)*js\/analytics-v2-outbox-engine\.js["']/;

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'functions', 'gas_v2', '.firebase']);

/** siteRoot配下の*.htmlファイルを再帰的に列挙する（除外ディレクトリはスキップ）。 */
function listHtmlFiles_(dir, out) {
  out = out || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      listHtmlFiles_(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 1ファイル分の解析結果を返す。engineIndex／v2Index／drainOnlyIndexは、
 * 対応する<script>タグがファイル内で最初に出現する文字位置（無ければ-1）。
 * 「engineがv2/drain-onlyより前にあるか」の順序検査に使う。
 * @returns {{file:string, hasV1:boolean, hasV2:boolean, hasDrainOnly:boolean, hasEngine:boolean, engineIndex:number, v2Index:number, drainOnlyIndex:number}}
 */
function analyzeFile_(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const v2Match = content.match(V2_PATTERN);
  const drainOnlyMatch = content.match(DRAIN_ONLY_PATTERN);
  const engineMatch = content.match(ENGINE_PATTERN);
  return {
    file: filePath,
    hasV1: V1_PATTERN.test(content),
    hasV2: !!v2Match,
    hasDrainOnly: !!drainOnlyMatch,
    hasEngine: !!engineMatch,
    engineIndex: engineMatch ? engineMatch.index : -1,
    v2Index: v2Match ? v2Match.index : -1,
    drainOnlyIndex: drainOnlyMatch ? drainOnlyMatch.index : -1
  };
}

/**
 * 排他切替の検査本体。ファイルI/Oを直接行わず、解析済みレコード配列を
 * 受け取る形にすることで、テストから純粋関数として呼び出せるようにする。
 * @param {Array<{file:string, hasV1:boolean, hasV2:boolean, hasDrainOnly:boolean}>} records
 * @returns {{ok:boolean, violations:Array<{file:string, reason:string}>, siteMode:('v1'|'v2'|'mixed'|'none')}}
 */
function checkExclusiveSwitch(records) {
  const violations = [];
  const withAnalytics = records.filter(function (r) { return r.hasV1 || r.hasV2; });

  for (const r of records) {
    if (r.hasV1 && r.hasV2) {
      violations.push({ file: r.file, reason: 'V1(js/analytics.js)とV2(js/analytics-v2.js)を同一ページで同時ロードしている（並行起動禁止違反）' });
    }
    if (r.hasV2 && r.hasDrainOnly) {
      violations.push({ file: r.file, reason: 'V2フルトラッカーとdrain-onlyローダーを同一ページで同時ロードしている（drain-onlyはV1稼働中ページ専用）' });
    }
    // R9再監査対応・項目2：V2フルトラッカー／drain-onlyローダーはengineへ実行時依存する。
    if (r.hasV2 && !r.hasEngine) {
      violations.push({ file: r.file, reason: 'js/analytics-v2.jsを読み込んでいるが、実行時依存先のjs/analytics-v2-outbox-engine.jsの<script>タグが無い（未定義のまま実行され機能が丸ごと動かない）' });
    }
    if (r.hasDrainOnly && !r.hasEngine) {
      violations.push({ file: r.file, reason: 'js/analytics-v2-drain-only.jsを読み込んでいるが、実行時依存先のjs/analytics-v2-outbox-engine.jsの<script>タグが無い（未定義のまま実行され機能が丸ごと動かない）' });
    }
    if (r.hasV2 && r.hasEngine && r.engineIndex > r.v2Index) {
      violations.push({ file: r.file, reason: 'js/analytics-v2-outbox-engine.jsの<script>タグがjs/analytics-v2.jsより後に置かれている（engineが未定義の状態でv2本体が実行される）' });
    }
    if (r.hasDrainOnly && r.hasEngine && r.engineIndex > r.drainOnlyIndex) {
      violations.push({ file: r.file, reason: 'js/analytics-v2-outbox-engine.jsの<script>タグがjs/analytics-v2-drain-only.jsより後に置かれている（engineが未定義の状態でdrain-only本体が実行される）' });
    }
  }

  const anyV1 = withAnalytics.some(function (r) { return r.hasV1; });
  const anyV2 = withAnalytics.some(function (r) { return r.hasV2; });
  let siteMode = 'none';
  if (anyV1 && anyV2) {
    siteMode = 'mixed';
  } else if (anyV2) {
    siteMode = 'v2';
  } else if (anyV1) {
    siteMode = 'v1';
  }

  if (siteMode === 'mixed') {
    // サイト全体としてどのページがどちらのモードかを個別に報告する
    // （中途半端な切替状態はページ単位のV1/V2併存が無くてもBLOCK対象）。
    for (const r of withAnalytics) {
      const mode = r.hasV2 ? 'v2' : 'v1';
      violations.push({ file: r.file, reason: 'サイト全体でモードが揃っていない（このページは' + mode + 'だが、他のページで別モードが検出された）' });
    }
  }

  return { ok: violations.length === 0, violations: violations, siteMode: siteMode };
}

function run_(siteRoot) {
  const files = listHtmlFiles_(siteRoot);
  const records = files.map(analyzeFile_);
  return checkExclusiveSwitch(records);
}

if (require.main === module) {
  const siteRoot = process.argv[2] || path.resolve(__dirname, '..', '..');
  const result = run_(siteRoot);
  if (result.ok) {
    console.log('PASS: V1/V2 analytics排他切替チェック OK（siteMode=' + result.siteMode + '）');
    process.exitCode = 0;
  } else {
    console.error('BLOCK: V1/V2 analytics排他切替違反を検出（siteMode=' + result.siteMode + '）');
    result.violations.forEach(function (v) {
      console.error('  - ' + v.file + ' : ' + v.reason);
    });
    process.exitCode = 1;
  }
}

module.exports = { checkExclusiveSwitch, analyzeFile_, listHtmlFiles_, run_ };
