'use strict';
/* =====================================================================
 * VERIFY JWTローカル発行機構（独立監査再提出R9・項目3）の検証テスト。
 * 実gcloud CLI・実Secret Managerへは一切接続しない（deps差し替えでモック化）。
 * ===================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  issueVerifyJwtLocal,
  REQUIRED_ACTIVE_ACCOUNT,
  VERIFY_JWT_AUD,
  VERIFY_JWT_SCOPE,
  VERIFY_JWT_TTL_SECONDS
} = require('../scripts/verify_jwt_local_issuer');
const { verifyVerifyJwt } = require('../lib/funnelV2');

const FAKE_SECRET = 'unit-test-verify-jwt-secret-not-real-0123456789abcdef';

function captureConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  return {
    logs, errors,
    restore() { console.log = originalLog; console.error = originalError; }
  };
}

test('R9#3：gcloud active accountが確認済みアカウントと一致しない場合、fail-closedで拒否し、Secret Managerへは一切接続しない', () => {
  let secretCalled = false;
  const deps = {
    getActiveAccount: () => 'someone-else@example.com',
    getSecret: () => { secretCalled = true; return FAKE_SECRET; }
  };
  assert.throws(() => issueVerifyJwtLocal(deps), /fail-closed.*active account/);
  assert.equal(secretCalled, false, 'accountが一致しない時点でSecret Manager呼び出しに一切進まないこと');
});
test('R9#3：gcloud active accountが空（未認証）の場合もfail-closedで拒否する', () => {
  let secretCalled = false;
  const deps = {
    getActiveAccount: () => '',
    getSecret: () => { secretCalled = true; return FAKE_SECRET; }
  };
  assert.throws(() => issueVerifyJwtLocal(deps), /fail-closed.*active account/);
  assert.equal(secretCalled, false);
});
test('R9#3：gcloud active accountの確認自体が例外を投げた場合（認証切れ・ネットワーク断等）もfail-closedで拒否する（「確認できないから許可」にしない）', () => {
  let secretCalled = false;
  const deps = {
    getActiveAccount: () => { throw new Error('reauth related error (invalid_rapt)'); },
    getSecret: () => { secretCalled = true; return FAKE_SECRET; }
  };
  assert.throws(() => issueVerifyJwtLocal(deps), /fail-closed/);
  assert.equal(secretCalled, false);
});
test('R9#3：Secret Manager取得自体が例外を投げた場合はfail-closedで拒否する（Secret値をエラーメッセージへ含めない）', () => {
  const deps = {
    getActiveAccount: () => REQUIRED_ACTIVE_ACCOUNT,
    getSecret: () => { throw new Error('PERMISSION_DENIED: caller does not have permission'); }
  };
  let thrown = null;
  try { issueVerifyJwtLocal(deps); } catch (err) { thrown = err; }
  assert.ok(thrown, 'Secret取得失敗時は例外を投げる');
  assert.match(thrown.message, /fail-closed/);
  assert.equal(thrown.message.indexOf(FAKE_SECRET), -1, 'エラーメッセージにSecret値そのものを含めない');
});
test('R9#3：Secret Managerが空文字を返した場合もfail-closedで拒否する', () => {
  const deps = {
    getActiveAccount: () => REQUIRED_ACTIVE_ACCOUNT,
    getSecret: () => ''
  };
  assert.throws(() => issueVerifyJwtLocal(deps), /fail-closed.*空/);
});
test('R9#3：正常系：確認済みaccount一致・Secret取得成功時、正しいクレームでJWTが発行される（sub=確認済みaccount・aud=logInteractionV2Verify・scope・iat・exp=15分・ランダムjti）', () => {
  const deps = {
    getActiveAccount: () => REQUIRED_ACTIVE_ACCOUNT,
    getSecret: () => FAKE_SECRET
  };
  const result = issueVerifyJwtLocal(deps);
  assert.equal(result.sub, REQUIRED_ACTIVE_ACCOUNT);
  assert.ok(result.token && typeof result.token === 'string');
  assert.ok(result.jti && /^[0-9a-f]{32}$/.test(result.jti), 'jtiは安全なランダム形式（32文字小文字16進数）');
  assert.ok(result.exp > Math.floor(Date.now() / 1000), 'expは未来の時刻');

  // 発行されたJWTが、実際のverifyVerifyJwt()（本番と同じ検証ロジック）を
  // 正しく通過することを確認する（署名アルゴリズムを複製・再実装していないことの証拠）。
  const verdict = verifyVerifyJwt(result.token, FAKE_SECRET, {
    expectedAud: VERIFY_JWT_AUD, expectedScope: VERIFY_JWT_SCOPE, expectedSub: REQUIRED_ACTIVE_ACCOUNT
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.jti, result.jti);
});
test('R9#3：発行有効期間はちょうど15分（VERIFY_JWT_TTL_SECONDS）で、確定値を超えない', () => {
  const deps = { getActiveAccount: () => REQUIRED_ACTIVE_ACCOUNT, getSecret: () => FAKE_SECRET };
  const before = Math.floor(Date.now() / 1000);
  const result = issueVerifyJwtLocal(deps);
  const after = Math.floor(Date.now() / 1000);
  assert.equal(VERIFY_JWT_TTL_SECONDS, 15 * 60);
  assert.ok(result.exp - before <= 15 * 60 && result.exp - after >= 15 * 60 - 5, 'expがiat+15分（許容誤差5秒）の範囲内');
});
test('R9#3：正常系の発行フロー全体を通じて、Secret値・JWT本体のどちらもconsole.log/console.errorへ一切出力されない', () => {
  const deps = { getActiveAccount: () => REQUIRED_ACTIVE_ACCOUNT, getSecret: () => FAKE_SECRET };
  const capture = captureConsole();
  let result;
  try {
    result = issueVerifyJwtLocal(deps);
  } finally {
    capture.restore();
  }
  const allOutput = capture.logs.concat(capture.errors).join('\n');
  assert.equal(allOutput.indexOf(FAKE_SECRET), -1, 'Secret値がいかなるconsole出力にも含まれない');
  assert.equal(allOutput.indexOf(result.token), -1, 'JWT本体がいかなるconsole出力にも含まれない');
  assert.equal(capture.logs.length, 0, 'issueVerifyJwtLocal()自体はconsole.logを一切呼ばない（CLI直接実行時のrequire.main===moduleガード内だけが出力する設計）');
});
test('R9#3：fail-closedで拒否した場合も、Secret値・JWT本体を一切出力しない（拒否理由のメッセージのみ）', () => {
  const deps = { getActiveAccount: () => 'wrong@example.com', getSecret: () => FAKE_SECRET };
  const capture = captureConsole();
  try {
    assert.throws(() => issueVerifyJwtLocal(deps));
  } finally {
    capture.restore();
  }
  const allOutput = capture.logs.concat(capture.errors).join('\n');
  assert.equal(allOutput.indexOf(FAKE_SECRET), -1);
});
test('R9#3：このモジュールをrequire()するだけでは（CLIとして直接実行しない限り）一切のconsole出力・副作用が発生しない', () => {
  const capture = captureConsole();
  try {
    delete require.cache[require.resolve('../scripts/verify_jwt_local_issuer')];
    require('../scripts/verify_jwt_local_issuer');
  } finally {
    capture.restore();
  }
  assert.equal(capture.logs.length, 0);
  assert.equal(capture.errors.length, 0);
});
test('R9再監査#3：defaultDeps_が公開されている（getActiveAccount／getSecretを持つオブジェクトを返す関数）。実gcloud呼び出しはここでは行わず、構造だけを確認する（実gcloud呼び出し自体はnode scripts/verify_jwt_local_issuer.jsのCLI実行で別途確認済み。別ターン実施済み・READMEおよび完了報告に記録）', () => {
  const mod = require('../scripts/verify_jwt_local_issuer');
  assert.equal(typeof mod.defaultDeps_, 'function');
  const deps = mod.defaultDeps_();
  assert.equal(typeof deps.getActiveAccount, 'function');
  assert.equal(typeof deps.getSecret, 'function');
});
test('R9#3：現在の.secret.local依存Emulator harnessとは役割が分離されている（このモジュールはgcloud/Secret Managerだけを参照し、functions/.secret.localの読み込みコードを一切持たない）', () => {
  const src = require('fs').readFileSync(require.resolve('../scripts/verify_jwt_local_issuer'), 'utf8');
  // ドキュメントコメント内で説明目的に「.secret.local」という語自体へ言及するのは
  // 許容する（既存harnessとの違いを明示する目的で意図的に書いている）。実際に
  // そのファイルを読み込むコード（fs.readFileSyncやパス結合）が無いことを確認する。
  assert.equal(src.indexOf('readFileSync'), -1, 'fs.readFileSync等でローカルファイルを読み込むコードが無いこと（.secret.localを含むいかなるファイルも読まない設計）');
  assert.equal(src.indexOf('process.env.VERIFY_JWT_SECRET'), -1, '既存のprocess.env.VERIFY_JWT_SECRET（.secret.local/Firebase Secret経由でFunctionsランタイムへ注入される値）を読んでいないこと（gcloud secrets versions accessで独立に取得する設計）');
});
