#!/usr/bin/env node
'use strict';
/**
 * predeploy検査（単位EF正本仕様：「関数名とdataEnv対応を機械検査。不一致時はdeployをBLOCK」）。
 *
 * functions/index.jsのソーステキストを静的解析し、次を機械的に確認する：
 *  1. 関数名に"Verify"を含むエンドポイントは、VERIFY専用コレクション定数
 *     （V2_VERIFY_COLLECTIONS）だけを参照し、PROD専用コレクション定数
 *     （V2_PROD_COLLECTIONS）を参照しないこと。secrets配列に'VERIFY_JWT_SECRET'を
 *     含むこと。専用runtime service account（serviceAccount:オプション）を
 *     明示していること（独立監査再提出・項目5）。
 *  2. 関数名に"V2"を含み"Verify"を含まないエンドポイントは、V2_PROD_COLLECTIONSを
 *     参照する場合、V2_VERIFY_COLLECTIONSを参照しないこと。secrets配列に
 *     'VERIFY_JWT_SECRET'を含まないこと（VERIFY専用SecretがPROD関数へ漏れることを防ぐ）。
 *     serviceAccountオプションを持たないこと（VERIFY専用service accountがPROD関数へ
 *     漏れることを防ぐ）。
 *  3. V2_VERIFY_COLLECTIONSを参照するのに関数名へ"Verify"を含まない関数、または
 *     その逆（"Verify"を含むのにV2_VERIFY_COLLECTIONSを参照しない関数）が無いこと
 *     （命名規約と実装の乖離を検知する）。
 *  4. Verify関数のaudが関数名と同一であること（正本仕様：正式名と同名のaud）。
 *
 * 実際のFirestoreへは一切接続しない、純粋なテキスト静的解析。
 * 使い方: node scripts/predeploy_check_dataenv.js
 * 終了コード: 0=BLOCKなし（deployしてよい）、1=BLOCKあり（deployしてはいけない）
 *
 * npm run deploy は本スクリプト（predeploy:dataenv）を必ず先に実行し、非ゼロ終了なら
 * 実際のfirebase deployを呼ばない（独立監査再提出・項目8：npm run deployへ追加--onlyを
 * 渡す方式は禁止し、predeploy gateと限定firebase deployを明示的に別々に実行する）。
 */
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

/**
 * package.jsonのdeployスクリプトを検査する（独立監査再提出・項目8）。
 * - "npm run deploy"（追加引数で--onlyを渡す想定の汎用スクリプト）が存在しないこと
 *   （汎用スクリプトへ`-- --only ...`を渡す運用そのものを禁止する）。
 * - deploy:v2-verify の --only 対象が全て"Verify"を含む関数名であること
 *   （VERIFY_JWT_SECRET未作成時、この対象だけがdeploy失敗しても他は無関係のまま）。
 * - deploy:v2-prod-additive の --only 対象に"Verify"を含む関数名が一切無いこと
 *   （VERIFY関数が誤ってPROD追加deployへ混入しないことを保証する）。
 */
function checkDeployScripts(blockList) {
  if (!fs.existsSync(PACKAGE_JSON_PATH)) {
    blockList.push({ severity: 'BLOCK', item: 'package.json', detail: 'package.jsonが見つからない。' });
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const scripts = pkg.scripts || {};
  if (Object.prototype.hasOwnProperty.call(scripts, 'deploy')) {
    blockList.push({ severity: 'BLOCK', item: 'package.json:deploy', detail: '汎用"deploy"スクリプトが存在する（独立監査再提出・項目8：npm run deployへ追加--onlyを渡す方式は禁止。deploy:v1/deploy:v2-prod-additive/deploy:v2-verifyのように限定スコープの名前付きスクリプトのみを使うこと）。' });
  }
  function onlyTargets(scriptName) {
    const cmd = scripts[scriptName];
    if (!cmd) return null;
    const m = cmd.match(/--only\s+([^\s&]+)/);
    if (!m) return null;
    return m[1].split(',').map((s) => s.replace(/^functions:/, ''));
  }
  const verifyTargets = onlyTargets('deploy:v2-verify');
  if (!verifyTargets || !verifyTargets.length) {
    blockList.push({ severity: 'BLOCK', item: 'package.json:deploy:v2-verify', detail: 'deploy:v2-verifyスクリプトが無いか、--only対象を検出できない。' });
  } else {
    const nonVerify = verifyTargets.filter((n) => !/Verify/.test(n));
    if (nonVerify.length) blockList.push({ severity: 'BLOCK', item: 'package.json:deploy:v2-verify', detail: 'deploy:v2-verifyの--only対象に"Verify"を含まない関数名が混入している: ' + nonVerify.join(', ') });
  }
  const prodTargets = onlyTargets('deploy:v2-prod-additive');
  if (!prodTargets || !prodTargets.length) {
    blockList.push({ severity: 'BLOCK', item: 'package.json:deploy:v2-prod-additive', detail: 'deploy:v2-prod-additiveスクリプトが無いか、--only対象を検出できない。' });
  } else {
    const verifyLeak = prodTargets.filter((n) => /Verify/.test(n));
    if (verifyLeak.length) blockList.push({ severity: 'BLOCK', item: 'package.json:deploy:v2-prod-additive', detail: 'deploy:v2-prod-additiveの--only対象にVERIFY関数が混入している（VERIFY_JWT_SECRET未作成時、この一括deployが巻き込まれて失敗する設計はNG）: ' + verifyLeak.join(', ') });
  }
}

function main() {
  const source = fs.readFileSync(INDEX_PATH, 'utf8');
  const blockList = [];
  checkDeployScripts(blockList);

  // exports.NAME = onRequest( ... ) の出現位置ごとに、次のexports.出現（または末尾）
  // までをそのエンドポイントの完全なソース片とみなす（ネストした{}を厳密にパースせず、
  // 「このエンドポイント定義ブロックにXという識別子が含まれるか」だけを見る簡易静的解析）。
  const exportRegex = /exports\.(\w+)\s*=\s*onRequest\(/g;
  const matches = [];
  let m;
  while ((m = exportRegex.exec(source)) !== null) {
    matches.push({ name: m[1], start: m.index });
  }
  if (matches.length === 0) {
    blockList.push({ severity: 'BLOCK', item: 'exports検出', detail: 'functions/index.jsからexports.X = onRequest(...)形式のエンドポイントが1件も見つからない（正規表現がコード構造と乖離した可能性）。' });
  }

  const endpoints = matches.map((entry, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].start : source.length;
    return { name: entry.name, body: source.slice(entry.start, end) };
  });

  endpoints.forEach((ep) => {
    const nameHasVerify = /Verify/.test(ep.name);
    const nameHasV2 = /V2/.test(ep.name);
    const usesVerifyCollections = ep.body.indexOf('V2_VERIFY_COLLECTIONS') >= 0;
    const usesProdCollections = ep.body.indexOf('V2_PROD_COLLECTIONS') >= 0;
    const secretsMatch = ep.body.match(/secrets:\s*\[([^\]]*)\]/);
    const secretsList = secretsMatch ? secretsMatch[1] : '';
    const hasVerifySecret = /['"]VERIFY_JWT_SECRET['"]/.test(secretsList);
    const hasServiceAccountOption = /serviceAccount\s*:/.test(ep.body.split(/async\s*\(req/)[0] || ep.body);
    const audMatch = ep.body.match(/verifyVerifyRequest_\(\s*req\s*,\s*'([^']+)'\s*\)/);
    const audUsed = audMatch ? audMatch[1] : null;

    if (nameHasVerify) {
      if (usesProdCollections) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名に"Verify"を含むが、PROD専用コレクション定数(V2_PROD_COLLECTIONS)を参照している（VERIFYとPRODの分離違反）。' });
      }
      if (!usesVerifyCollections) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名に"Verify"を含むが、VERIFY専用コレクション定数(V2_VERIFY_COLLECTIONS)を一切参照していない（命名と実装の乖離）。' });
      }
      if (!hasVerifySecret) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名に"Verify"を含むが、secrets配列にVERIFY_JWT_SECRETが含まれていない（JWT検証に必要なSecretが配線されていない）。' });
      }
      if (!hasServiceAccountOption) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名に"Verify"を含むが、onRequestオプションにserviceAccountが明示されていない（正本仕様：VERIFY writerへ専用runtime serviceAccount名を明示する）。' });
      }
      // logInteractionV2Verify自身はverifyVerifyRequest_(req)を第2引数省略で呼ぶ（既定値が
      // 自分自身の関数名と一致する設計）ため、audチェックはlogInteractionV2Verify以外の
      // 読み取り系Verify関数（第2引数に明示的なaudを渡す設計）にのみ適用する。
      if (ep.name !== 'logInteractionV2Verify' && audUsed && audUsed !== ep.name) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: `audが関数名と一致しない（正本仕様：正式名と同名のaud）。検出されたaud: ${audUsed}` });
      }
    } else if (nameHasV2) {
      if (usesVerifyCollections) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名は"Verify"を含まないPROD系（V2）だが、VERIFY専用コレクション定数(V2_VERIFY_COLLECTIONS)を参照している（VERIFYとPRODの分離違反）。' });
      }
      if (hasVerifySecret) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名は"Verify"を含まないPROD系（V2）だが、secrets配列にVERIFY_JWT_SECRETが含まれている（VERIFY専用SecretがPROD関数へ漏れている）。' });
      }
      if (hasServiceAccountOption) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名は"Verify"を含まないPROD系（V2）だが、onRequestオプションにserviceAccountが指定されている（VERIFY専用service accountがPROD関数へ漏れている）。' });
      }
    }
    // "Verify"も"V2"も含まない関数（V1の既存エンドポイント等）はこのチェックの対象外。
  });

  console.log('=== predeploy dataEnv検査結果 ===');
  console.log('検出したV2/VERIFY関連エンドポイント: ' + endpoints.filter((e) => /V2|Verify/.test(e.name)).map((e) => e.name).join(', '));
  if (blockList.length === 0) {
    console.log('BLOCKなし。関数名とdataEnv（コレクション定数・Secret）の対応は全て規約どおり。');
  } else {
    blockList.forEach((b) => console.log(`[BLOCK] ${b.item}: ${b.detail}`));
  }
  process.exitCode = blockList.length > 0 ? 1 : 0;
}

main();
