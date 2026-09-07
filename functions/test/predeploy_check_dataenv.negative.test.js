'use strict';
/* =====================================================================
 * predeploy_check_dataenv.js（VERIFY署名鍵／読み取りトークンのscope検査ゲート）の
 * 負のテスト（独立監査再提出R6・項目5「negative tests proving deliberately-introduced
 * ... mismatches are correctly BLOCKed」の一部）。
 * 実ファイルI/Oは行わず、checkSource()へ直接「欠陥を注入した」ソース文字列／
 * package.jsonオブジェクトを渡し、BLOCKされる（blockList非空）ことを確認する。
 * 現状の（欠陥のない）functions/index.js・package.jsonを土台に、1箇所だけ
 * 意図的に壊したコピーを使う＝「たまたまBLOCKが出ている」ではなく「その欠陥を
 * 検出してBLOCKしている」ことを保証する。
 * ===================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { checkSource } = require('../scripts/predeploy_check_dataenv');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');
const realSource = fs.readFileSync(INDEX_PATH, 'utf8');
const realPkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

function findBlock(blockList, item, pattern) {
  return blockList.find((b) => b.item === item && pattern.test(b.detail));
}

test('健全な現状のindex.js・package.jsonはBLOCKなし（前提条件の確認）', () => {
  const { blockList } = checkSource(realSource, realPkg);
  assert.equal(blockList.length, 0, JSON.stringify(blockList));
});

test('負テスト（R6#4）：読み取り専用Verify関数へVERIFY_JWT_SECRET＋serviceAccountを注入するとBLOCKされる', () => {
  const needle = "exports.getFunnelInsightsV2Verify = onRequest(\r\n  {\r\n    region: 'us-central1',\r\n    cors: false,\r\n    secrets: ['VERIFY_READ_TOKEN']\r\n  },";
  assert.ok(realSource.includes(needle), '対象コードブロックが見つからない（index.jsの構造が変わった可能性）');
  const replacement = "exports.getFunnelInsightsV2Verify = onRequest(\r\n  {\r\n    region: 'us-central1',\r\n    cors: false,\r\n    secrets: ['VERIFY_READ_TOKEN', 'VERIFY_JWT_SECRET'],\r\n    serviceAccount: VERIFY_RUNTIME_SERVICE_ACCOUNT\r\n  },";
  const injected = realSource.replace(needle, replacement);
  const { blockList } = checkSource(injected, realPkg);
  assert.ok(findBlock(blockList, 'getFunnelInsightsV2Verify', /VERIFY_JWT_SECRET.*読み取り系は署名鍵/), JSON.stringify(blockList));
  assert.ok(findBlock(blockList, 'getFunnelInsightsV2Verify', /serviceAccount.*読み取り系は専用service account/), JSON.stringify(blockList));
});

test('負テスト（R6#4）：書き込み専用logInteractionV2VerifyからVERIFY_JWT_SECRETを外すとBLOCKされる', () => {
  const needle = "exports.logInteractionV2Verify = onRequest(\r\n  {\r\n    region: 'us-central1',\r\n    cors: false,\r\n    secrets: ['VERIFY_JWT_SECRET'],\r\n    serviceAccount: VERIFY_RUNTIME_SERVICE_ACCOUNT\r\n  },";
  assert.ok(realSource.includes(needle), '対象コードブロックが見つからない（index.jsの構造が変わった可能性）');
  const replacement = "exports.logInteractionV2Verify = onRequest(\r\n  {\r\n    region: 'us-central1',\r\n    cors: false,\r\n    serviceAccount: VERIFY_RUNTIME_SERVICE_ACCOUNT\r\n  },";
  const injected = realSource.replace(needle, replacement);
  const { blockList } = checkSource(injected, realPkg);
  assert.ok(findBlock(blockList, 'logInteractionV2Verify', /VERIFY_JWT_SECRETが含まれていない/), JSON.stringify(blockList));
});

test('負テスト（R6#4）：読み取り専用Verify関数がVERIFY_READ_TOKENを持たずrequireVerifyReadToken()も呼ばないとBLOCKされる', () => {
  const needle = "if (!requireVerifyReadToken(req, res)) return;";
  assert.ok(realSource.includes(needle), '対象コードが見つからない（index.jsの構造が変わった可能性）');
  const injected = realSource.replace(needle, 'if (false) return;');
  const { blockList } = checkSource(injected, realPkg);
  const hits = blockList.filter((b) => /requireVerifyReadToken/.test(b.detail));
  assert.ok(hits.length >= 1, JSON.stringify(blockList));
});

test('負テスト（R2既存機能の回帰）：PROD系V2関数がV2_VERIFY_COLLECTIONSを参照するとBLOCKされる', () => {
  const needle = 'const result = await runV2InsightsQuery_(V2_PROD_COLLECTIONS, period, levelFilter);';
  assert.ok(realSource.includes(needle), '対象コードが見つからない（index.jsの構造が変わった可能性）');
  const injected = realSource.replace(needle, 'const result = await runV2InsightsQuery_(V2_VERIFY_COLLECTIONS, period, levelFilter);');
  const { blockList } = checkSource(injected, realPkg);
  assert.ok(findBlock(blockList, 'getFunnelInsightsV2', /VERIFYとPRODの分離違反/), JSON.stringify(blockList));
});

test('負テスト（package.json）：deploy:v2-verifyの--only対象に非Verify関数が混入するとBLOCKされる', () => {
  const badPkg = JSON.parse(JSON.stringify(realPkg));
  badPkg.scripts['deploy:v2-verify'] = badPkg.scripts['deploy:v2-verify'].replace('--only functions:', '--only functions:getFunnelInsightsV2,functions:');
  const { blockList } = checkSource(realSource, badPkg);
  assert.ok(findBlock(blockList, 'package.json:deploy:v2-verify', /"Verify"を含まない関数名が混入/), JSON.stringify(blockList));
});

test('負テスト（package.json）：汎用"deploy"スクリプトが存在するとBLOCKされる', () => {
  const badPkg = JSON.parse(JSON.stringify(realPkg));
  badPkg.scripts.deploy = 'firebase deploy';
  const { blockList } = checkSource(realSource, badPkg);
  assert.ok(findBlock(blockList, 'package.json:deploy', /汎用"deploy"スクリプトが存在する/), JSON.stringify(blockList));
});

/* ---------------------------------------------------------------------
 * 負テスト（R7・項目6追加確認）：firestore.indexes.jsonの複合インデックスゲート。
 * 実ファイルは一切書き換えず、checkSource()の第3引数（firestoreIndexesOverrides）
 * でindexesDoc／firebaseJsonを注入して欠陥ケースを再現する（実ファイルI/Oなし）。
 * ------------------------------------------------------------------- */

const REAL_INDEXES_DOC = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.indexes.json'), 'utf8')
);
const REAL_FIREBASE_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'firebase.json'), 'utf8')
);

test('前提条件：健全なfirestore.indexes.json／firebase.jsonの組み合わせはBLOCKなし', () => {
  const { blockList } = checkSource(realSource, realPkg, {
    indexesDoc: REAL_INDEXES_DOC,
    firebaseJson: REAL_FIREBASE_JSON
  });
  assert.equal(blockList.length, 0, JSON.stringify(blockList));
});

test('負テスト（R7#6）：firestore.indexes.jsonが存在しないとBLOCKされる', () => {
  const { blockList } = checkSource(realSource, realPkg, {
    indexesMissing: true,
    firebaseJson: REAL_FIREBASE_JSON
  });
  assert.ok(findBlock(blockList, 'firestore.indexes.json', /存在しない/), JSON.stringify(blockList));
});

test('負テスト（R7#6）：interaction_logsの複合インデックス定義を欠くとBLOCKされる', () => {
  const badIndexesDoc = JSON.parse(JSON.stringify(REAL_INDEXES_DOC));
  badIndexesDoc.indexes = badIndexesDoc.indexes.filter((idx) => idx.collectionGroup !== 'interaction_logs');
  const { blockList } = checkSource(realSource, realPkg, {
    indexesDoc: badIndexesDoc,
    firebaseJson: REAL_FIREBASE_JSON
  });
  assert.ok(findBlock(blockList, 'firestore.indexes.json:interaction_logs', /複合インデックス定義が見つからない/), JSON.stringify(blockList));
});

test('負テスト（R7#6）：interaction_logs_verifyの複合インデックス定義を欠くとBLOCKされる', () => {
  const badIndexesDoc = JSON.parse(JSON.stringify(REAL_INDEXES_DOC));
  badIndexesDoc.indexes = badIndexesDoc.indexes.filter((idx) => idx.collectionGroup !== 'interaction_logs_verify');
  const { blockList } = checkSource(realSource, realPkg, {
    indexesDoc: badIndexesDoc,
    firebaseJson: REAL_FIREBASE_JSON
  });
  assert.ok(findBlock(blockList, 'firestore.indexes.json:interaction_logs_verify', /複合インデックス定義が見つからない/), JSON.stringify(blockList));
});

test('負テスト（R7#6）：複合インデックスがevent_typeのみ（occurred_at欠落）だとBLOCKされる', () => {
  const badIndexesDoc = JSON.parse(JSON.stringify(REAL_INDEXES_DOC));
  badIndexesDoc.indexes = badIndexesDoc.indexes.map((idx) => {
    if (idx.collectionGroup !== 'interaction_logs') return idx;
    return { ...idx, fields: idx.fields.filter((f) => f.fieldPath !== 'occurred_at') };
  });
  const { blockList } = checkSource(realSource, realPkg, {
    indexesDoc: badIndexesDoc,
    firebaseJson: REAL_FIREBASE_JSON
  });
  assert.ok(findBlock(blockList, 'firestore.indexes.json:interaction_logs', /複合インデックス定義が見つからない/), JSON.stringify(blockList));
});

test('負テスト（R7#6）：firebase.jsonが存在しないとBLOCKされる', () => {
  const { blockList } = checkSource(realSource, realPkg, {
    indexesDoc: REAL_INDEXES_DOC,
    firebaseJsonMissing: true
  });
  assert.ok(findBlock(blockList, 'firebase.json', /存在しない/), JSON.stringify(blockList));
});

test('負テスト（R7#6）：firebase.jsonのfirestore.indexesがfirestore.indexes.jsonを参照していないとBLOCKされる', () => {
  const badFirebaseJson = JSON.parse(JSON.stringify(REAL_FIREBASE_JSON));
  delete badFirebaseJson.firestore.indexes;
  const { blockList } = checkSource(realSource, realPkg, {
    indexesDoc: REAL_INDEXES_DOC,
    firebaseJson: badFirebaseJson
  });
  assert.ok(findBlock(blockList, 'firebase.json:firestore.indexes', /firestore\.indexes\.jsonを参照していない/), JSON.stringify(blockList));
});
