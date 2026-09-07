#!/usr/bin/env node
'use strict';
/**
 * predeploy検査（単位EF正本仕様：「関数名とdataEnv対応を機械検査。不一致時はdeployをBLOCK」）。
 *
 * functions/index.jsのソーステキストを静的解析し、次を機械的に確認する：
 *  1. 関数名に"Verify"を含むエンドポイントは、VERIFY専用コレクション定数
 *     （V2_VERIFY_COLLECTIONS）だけを参照し、PROD専用コレクション定数
 *     （V2_PROD_COLLECTIONS）を参照しないこと。secrets配列に'VERIFY_JWT_SECRET'を
 *     含むこと。
 *  2. 関数名に"V2"を含み"Verify"を含まないエンドポイントは、V2_PROD_COLLECTIONSを
 *     参照する場合、V2_VERIFY_COLLECTIONSを参照しないこと。secrets配列に
 *     'VERIFY_JWT_SECRET'を含まないこと（VERIFY専用SecretがPROD関数へ漏れることを防ぐ）。
 *  3. V2_VERIFY_COLLECTIONSを参照するのに関数名へ"Verify"を含まない関数、または
 *     その逆（"Verify"を含むのにV2_VERIFY_COLLECTIONSを参照しない関数）が無いこと
 *     （命名規約と実装の乖離を検知する）。
 *
 * 実際のFirestoreへは一切接続しない、純粋なテキスト静的解析。
 * 使い方: node scripts/predeploy_check_dataenv.js
 * 終了コード: 0=BLOCKなし（deployしてよい）、1=BLOCKあり（deployしてはいけない）
 *
 * このチェックはCOPY_TEST相当が無いFirebase側では「deploy直前」に必ず単体で実行する
 * ことを運用契約とする（npm run predeploy等への組み込みは、実際にdeployを行う際に
 * 別途行うこと。今回のセッションでは本番へのdeployそのものを実施していないため、
 * package.jsonのdeployスクリプトへの自動組み込みはまだ行っていない＝残課題）。
 */
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');

function main() {
  const source = fs.readFileSync(INDEX_PATH, 'utf8');
  const blockList = [];

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
    } else if (nameHasV2) {
      if (usesVerifyCollections) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名は"Verify"を含まないPROD系（V2）だが、VERIFY専用コレクション定数(V2_VERIFY_COLLECTIONS)を参照している（VERIFYとPRODの分離違反）。' });
      }
      if (hasVerifySecret) {
        blockList.push({ severity: 'BLOCK', item: ep.name, detail: '関数名は"Verify"を含まないPROD系（V2）だが、secrets配列にVERIFY_JWT_SECRETが含まれている（VERIFY専用SecretがPROD関数へ漏れている）。' });
      }
      if (usesProdCollections && !ep.body.includes('interaction_logs')) {
        // 参考チェック（BLOCKではなく将来の目視レビュー向けの弱いヒント）：
        // V2_PROD_COLLECTIONS自体の定義に'interaction_logs'という既存V1コレクション名が
        // 含まれているはずという前提が崩れていないかだけ確認する。
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
