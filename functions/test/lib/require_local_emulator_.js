'use strict';
/**
 * 実Firestoreクライアント初期化「前」に、FIRESTORE_EMULATOR_HOSTがローカル
 * エミュレータを指していることを検証する共通ガード（独立監査再提出R9再監査対応・
 * 項目1で新設）。
 *
 * 【新設の経緯（実インシデント）】
 * 2026-09-07〜08、functions/test/emulator_v2_e2e_20260907.jsを
 * `firebase emulators:exec`の子プロセスとしてではなく、手動で別プロセスとして
 * 直接`node functions/test/emulator_v2_e2e_20260907.js`実行した際、
 * `FIRESTORE_EMULATOR_HOST`（emulators:execが子プロセスへ自動注入する環境変数）が
 * 設定されないまま`getFirestore(initializeApp(...))`が実行され、当時有効化された
 * Application Default Credentialsにより実本番Firestore（aokitosou-miniapp）へ
 * 接続してしまった。HTTP経由のCloud Functions呼び出し（`request()`関数。ローカル
 * emulatorの固定ポート127.0.0.1:5001を直接指す設計）は正しくローカルemulatorへ
 * ルーティングされ続けたが、テストスクリプト内で直接Admin SDK経由で行っていた
 * `db.collection('interaction_logs').doc(...).set(...)`（5件）が実本番
 * Firestoreへ書き込まれてしまった。REST APIによる読み取り専用クエリで実際に
 * 該当5ドキュメント（`e2e_v1legacy_hash_*`・`e2e_v1legacy_nohash1_*`・
 * `e2e_v1legacy_nohash2_*`・`e2e_r7legacy_*`・`e2e_r7legacy_reaction_*`、
 * 2026-09-07T16:12:35-36Z作成）を実測確認し、完了報告に記録した。
 *
 * このガードは、Firestore Admin SDKクライアントを初期化する直前に必ず呼び出し、
 * `FIRESTORE_EMULATOR_HOST`が未設定、またはローカルホスト以外を指している場合は、
 * クライアント初期化そのものへ進む前に即座にプロセスを終了する（fail-closed。
 * 「認証済みなら本番へフォールバックしてもよい」という設計を明確に禁止する）。
 */
function requireLocalFirestoreEmulator() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    console.error(
      'FATAL: FIRESTORE_EMULATOR_HOST未設定のため中止する。' +
      'このスクリプトは`firebase emulators:exec --only functions,firestore "node <このファイル>"`' +
      '経由でのみ実行すること（本番Firestoreへの誤接続を防ぐfail-closedガード）。'
    );
    process.exit(1);
  }
  const hostname = String(host).split(':')[0];
  const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    console.error(
      'FATAL: FIRESTORE_EMULATOR_HOST（' + host + '）がローカルホストを指していない。' +
      '本番Firestoreへの誤接続を防ぐため中止する。'
    );
    process.exit(1);
  }
}

module.exports = { requireLocalFirestoreEmulator };
