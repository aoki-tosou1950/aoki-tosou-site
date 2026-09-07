#!/usr/bin/env node
'use strict';
/**
 * predeploy検査（単位EF正本仕様：「関数名とdataEnv対応を機械検査。不一致時はdeployをBLOCK」）。
 *
 * functions/index.jsのソーステキストを静的解析し、次を機械的に確認する：
 *  1. 関数名に"Verify"を含むエンドポイントは、VERIFY専用コレクション定数
 *     （V2_VERIFY_COLLECTIONS）だけを参照し、PROD専用コレクション定数
 *     （V2_PROD_COLLECTIONS）を参照しないこと。
 *  1a. 書き込み専用のlogInteractionV2Verifyだけが、secrets配列に'VERIFY_JWT_SECRET'
 *     （署名鍵）を含み、専用runtime service account（serviceAccount:オプション）を
 *     明示していること。VERIFY_READ_TOKEN（読み取り専用トークン）は持たないこと
 *     （監査差し戻し・独立監査再提出R6・項目4：署名鍵は書き込み専用に厳密に限定する）。
 *  1b. 読み取り3系（getFunnelInsightsV2Verify／getFunnelDrilldownV2Verify／
 *     getFunnelRecentActivityV2Verify）は、VERIFY_JWT_SECRET・serviceAccount
 *     （funnel-verify-runtime専用SA）のいずれも一切持たないこと（BLOCK対象）。
 *     代わりにsecrets配列に'VERIFY_READ_TOKEN'を含み、requireVerifyReadToken()を
 *     呼んでいること。verifyVerifyRequest_（署名鍵検証）を一切呼んでいないこと。
 *  2. 関数名に"V2"を含み"Verify"を含まないエンドポイントは、V2_PROD_COLLECTIONSを
 *     参照する場合、V2_VERIFY_COLLECTIONSを参照しないこと。secrets配列に
 *     'VERIFY_JWT_SECRET'も'VERIFY_READ_TOKEN'も含まないこと（VERIFY専用SecretがPROD
 *     関数へ漏れることを防ぐ）。serviceAccountオプションを持たないこと（VERIFY専用
 *     service accountがPROD関数へ漏れることを防ぐ）。
 *  3. V2_VERIFY_COLLECTIONSを参照するのに関数名へ"Verify"を含まない関数、または
 *     その逆（"Verify"を含むのにV2_VERIFY_COLLECTIONSを参照しない関数）が無いこと
 *     （命名規約と実装の乖離を検知する）。
 *  4. logInteractionV2VerifyのJWT audが自分自身の関数名と同一であること
 *     （正本仕様：正式名と同名のaud）。
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
function checkDeployScripts(blockList, pkg) {
  if (!pkg) {
    if (!fs.existsSync(PACKAGE_JSON_PATH)) {
      blockList.push({ severity: 'BLOCK', item: 'package.json', detail: 'package.jsonが見つからない。' });
      return;
    }
    pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  }
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

/**
 * 監査差し戻し（独立監査再提出R6）：負のテスト（意図的に欠陥を注入したsource/pkgを
 * 渡してBLOCKされることを確認するテスト）から呼べるよう、ファイルI/O・exitCode設定を
 * 行わない純粋な検査関数として分離した（main()はCLI用の薄いラッパーとしてこれを呼ぶ）。
 * @param {string} source functions/index.jsのソーステキスト
 * @param {object} pkg functions/package.jsonをJSON.parseしたオブジェクト（省略時は実ファイル）
 * @returns {Array<{severity:string,item:string,detail:string}>} blockList
 */
function checkSource(source, pkg) {
  const blockList = [];
  checkDeployScripts(blockList, pkg);

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
    const hasReadToken = /['"]VERIFY_READ_TOKEN['"]/.test(secretsList);
    const hasServiceAccountOption = /serviceAccount\s*:/.test(ep.body.split(/async\s*\(req/)[0] || ep.body);
    const callsVerifyJwtCheck = /verifyVerifyRequest_\s*\(/.test(ep.body);
    const callsReadTokenCheck = /requireVerifyReadToken\s*\(/.test(ep.body);
    const isVerifyWriter = ep.name === 'logInteractionV2Verify';

    if (nameHasVerify) {
      if (usesProdCollections) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名に"Verify"を含むが、PROD専用コレクション定数(V2_PROD_COLLECTIONS)を参照している（VERIFYとPRODの分離違反）。' });
      }
      if (!usesVerifyCollections) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名に"Verify"を含むが、VERIFY専用コレクション定数(V2_VERIFY_COLLECTIONS)を一切参照していない（命名と実装の乖離）。' });
      }

      if (isVerifyWriter) {
        // 監査差し戻し（独立監査再提出R6）#4：書き込み専用のlogInteractionV2Verifyだけが
        // 署名鍵VERIFY_JWT_SECRET・専用runtime service accountを持ってよい（必須）。
        if (!hasVerifySecret) {
          blockList.push({ severity: 'BLOCK', item: ep.name, detail: '書き込み専用Verify関数だが、secrets配列にVERIFY_JWT_SECRETが含まれていない（JWT署名に必要なSecretが配線されていない）。' });
        }
        if (!hasServiceAccountOption) {
          blockList.push({ severity: 'BLOCK', item: ep.name, detail: '書き込み専用Verify関数だが、onRequestオプションにserviceAccountが明示されていない（正本仕様：VERIFY writerへ専用runtime serviceAccount名を明示する）。' });
        }
        if (hasReadToken) {
          blockList.push({ severity: 'BLOCK', item: ep.name, detail: '書き込み専用Verify関数がVERIFY_READ_TOKEN（読み取り専用トークン）を持っている（署名鍵と読み取りトークンを分離すること）。' });
        }
      } else {
        // 監査差し戻し（独立監査再提出R6）#4の核心：読み取り3系はVERIFY_JWT_SECRETも
        // 専用service accountも一切使ってはならない（BLOCK対象）。VERIFY_READ_TOKENと
        // requireVerifyReadToken()だけで認可すること。
        if (hasVerifySecret) {
          blockList.push({ severity: 'BLOCK', item: ep.name, detail: '読み取り専用Verify関数だが、secrets配列にVERIFY_JWT_SECRET（書き込み専用署名鍵）が含まれている（読み取り系は署名鍵を使ってはならない）。' });
        }
        if (hasServiceAccountOption) {
          blockList.push({ severity: 'BLOCK', item: ep.name, detail: '読み取り専用Verify関数だが、onRequestオプションにserviceAccount（書き込み専用runtime SA）が指定されている（読み取り系は専用service accountを使ってはならない）。' });
        }
        if (callsVerifyJwtCheck) {
          blockList.push({ severity: 'BLOCK', item: ep.name, detail: '読み取り専用Verify関数がverifyVerifyRequest_（署名鍵JWT検証）を呼んでいる（読み取り系から署名鍵ロジックを排除すること）。' });
        }
        if (!hasReadToken) {
          blockList.push({ severity: 'BLOCK', item: ep.name, detail: '読み取り専用Verify関数だが、secrets配列にVERIFY_READ_TOKENが含まれていない。' });
        }
        if (!callsReadTokenCheck) {
          blockList.push({ severity: 'BLOCK', item: ep.name, detail: '読み取り専用Verify関数だが、requireVerifyReadToken()を呼んでいない（認可ロジックが配線されていない）。' });
        }
      }
    } else if (nameHasV2) {
      if (usesVerifyCollections) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名は"Verify"を含まないPROD系（V2）だが、VERIFY専用コレクション定数(V2_VERIFY_COLLECTIONS)を参照している（VERIFYとPRODの分離違反）。' });
      }
      if (hasVerifySecret) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名は"Verify"を含まないPROD系（V2）だが、secrets配列にVERIFY_JWT_SECRETが含まれている（VERIFY専用SecretがPROD関数へ漏れている）。' });
      }
      if (hasReadToken) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名は"Verify"を含まないPROD系（V2）だが、secrets配列にVERIFY_READ_TOKENが含まれている（VERIFY専用SecretがPROD関数へ漏れている）。' });
      }
      if (hasServiceAccountOption) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名は"Verify"を含まないPROD系（V2）だが、onRequestオプションにserviceAccountが指定されている（VERIFY専用service accountがPROD関数へ漏れている）。' });
      }
    }
    // "Verify"も"V2"も含まない関数（V1の既存エンドポイント等）はこのチェックの対象外。
  });

  return { blockList, endpointNames: endpoints.filter((e) => /V2|Verify/.test(e.name)).map((e) => e.name) };
}

function main() {
  const source = fs.readFileSync(INDEX_PATH, 'utf8');
  const { blockList, endpointNames } = checkSource(source);

  console.log('=== predeploy dataEnv検査結果 ===');
  console.log('検出したV2/VERIFY関連エンドポイント: ' + endpointNames.join(', '));
  if (blockList.length === 0) {
    console.log('BLOCKなし。関数名とdataEnv（コレクション定数・Secret）の対応は全て規約どおり。');
  } else {
    blockList.forEach((b) => console.log(`[BLOCK] ${b.item}: ${b.detail}`));
  }
  process.exitCode = blockList.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = { checkSource, checkDeployScripts };
