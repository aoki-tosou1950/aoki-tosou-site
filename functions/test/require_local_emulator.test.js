'use strict';
/* =====================================================================
 * 独立監査再提出R9再監査対応・項目1：FIRESTORE_EMULATOR_HOST未設定・非ローカル
 * ならFirestoreクライアント初期化前に即座に停止するガードの回帰テスト。
 *
 * 実インシデント（2026-09-07〜08）：functions/test/emulator_v2_e2e_20260907.jsを
 * `firebase emulators:exec`の子プロセスとしてでなく手動で直接実行した際、
 * FIRESTORE_EMULATOR_HOSTが注入されず、有効なApplication Default Credentials
 * により実本番Firestore（aokitosou-miniapp）のinteraction_logsコレクションへ
 * 5件のテスト用ドキュメントが書き込まれてしまった（詳細はrequire_local_emulator_.js
 * のコメント・完了報告参照）。このテストはガード関数自体を子プロセスとして
 * 実行し、実際に環境変数の状態に応じて期待どおり即座exitすることを確認する
 * （ガード関数はprocess.exit(1)を呼ぶため、同一プロセス内でassert.throwsする
 * 形では検証できず、子プロセスとして起動しexit codeを確認する必要がある）。
 * ===================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const GUARD_PATH = path.join(__dirname, 'lib', 'require_local_emulator_.js');

/** ガード関数を子プロセスで呼び出し、{status, stderr}を返す。 */
function runGuardInChildProcess(envOverrides) {
  const env = Object.assign({}, process.env, envOverrides);
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(GUARD_PATH)}).requireLocalFirestoreEmulator();console.log('GUARD_PASSED');`], {
    env, encoding: 'utf8'
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('R9再監査#1：FIRESTORE_EMULATOR_HOST未設定なら、Firestoreクライアント初期化を試みる前に即座exit(1)する', () => {
  const env = { FIRESTORE_EMULATOR_HOST: '' };
  delete env.FIRESTORE_EMULATOR_HOST;
  const result = runGuardInChildProcess({ FIRESTORE_EMULATOR_HOST: undefined });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FIRESTORE_EMULATOR_HOST未設定/);
  assert.doesNotMatch(result.stdout, /GUARD_PASSED/);
});

test('R9再監査#1：FIRESTORE_EMULATOR_HOSTが非ローカルホスト（実在しそうな外部ホスト名）を指している場合も即座exit(1)する', () => {
  const result = runGuardInChildProcess({ FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ローカルホストを指していない/);
  assert.doesNotMatch(result.stdout, /GUARD_PASSED/);
});

test('R9再監査#1：FIRESTORE_EMULATOR_HOSTが127.0.0.1を指していれば通過する', () => {
  const result = runGuardInChildProcess({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8089' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /GUARD_PASSED/);
});

test('R9再監査#1：FIRESTORE_EMULATOR_HOSTがlocalhostを指していれば通過する', () => {
  const result = runGuardInChildProcess({ FIRESTORE_EMULATOR_HOST: 'localhost:8089' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /GUARD_PASSED/);
});

test('R9再監査#1：認証済み（ADC等）であることは、このガードの通過条件に一切影響しない（「認証済みなら本番へフォールバックしてよい」という設計を許さない）', () => {
  // GOOGLE_APPLICATION_CREDENTIALS等の認証系環境変数が仮に設定されていても、
  // FIRESTORE_EMULATOR_HOSTが無ければガードは無条件にexit(1)する。
  const result = runGuardInChildProcess({
    FIRESTORE_EMULATOR_HOST: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: '/fake/path/to/adc.json',
    GCLOUD_PROJECT: 'aokitosou-miniapp'
  });
  assert.equal(result.status, 1);
});

test('R9再監査#1：emulator_v2_e2e_20260907.js・emulator.integration.js・emulator_readonly_check_20260907.jsのいずれも、Firestore Admin SDK初期化前にこのガードを呼び出している（静的確認。実インシデントが起きたファイル自体の再発防止）', () => {
  const fs = require('fs');
  const targets = ['emulator_v2_e2e_20260907.js', 'emulator.integration.js', 'emulator_readonly_check_20260907.js'];
  targets.forEach((f) => {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const guardIdx = src.indexOf('requireLocalFirestoreEmulator()');
    const initIdx = src.search(/getFirestore\s*\(/);
    assert.ok(guardIdx >= 0, f + ': requireLocalFirestoreEmulator()の呼び出しが無い');
    assert.ok(initIdx >= 0, f + ': getFirestore(...)の呼び出しが見つからない（テスト対象自体が変わっていないか確認）');
    assert.ok(guardIdx < initIdx, f + ': ガード呼び出しがgetFirestore(...)より後にある（初期化前に検証する契約違反）');
  });
});
