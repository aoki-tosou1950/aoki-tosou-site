'use strict';
/**
 * VERIFY書込みJWT（logInteractionV2Verify用）のローカル発行機構（独立監査再提出
 * R9・項目3で新設）。
 *
 * 【現在の.secret.local依存Emulator harnessとは役割を分離する】
 * functions/test/emulator_v2_e2e_20260907.js等の既存Emulator E2Eは、
 * functions/.secret.local（gitignore対象・ローカル専用ダミー値）からVERIFY_JWT_SECRETを
 * 読み込んでJWTを署名している。これはFirestore/Functions Emulatorに対する
 * ローカル検証専用の仕組みであり、本番のGoogle Secret Managerには一切接続しない。
 * 本モジュールはこれとは別物：実際のGoogle Cloud Secret Manager（本番プロジェクト
 * aokitosou-miniapp配下）からVERIFY_JWT_SECRETを取得し、実COPY_TEST／実VERIFY
 * エンドポイント（deploy後）に対して使える、認証済み・fail-closedなJWT発行機構
 * である。既存のEmulator harnessのコード・秘密値読み込み経路には一切手を加えない
 * （混同しない・置き換えない）。
 *
 * 【fail-closed契約】
 * 1. gcloudの現在のactive accountが、確認済みの単一アカウント
 *    （info@aoki-tosou.net）と完全一致することを、Secret Manager呼び出しより
 *    前に検証する。一致しない・確認自体に失敗した場合は、Secret Managerへは
 *    一切接続せず例外を投げる。
 * 2. VERIFY_JWT_SECRET（署名鍵）は、取得した後も標準出力・console.error・
 *    ログファイル・一時ファイルへ一切出力しない（このモジュール自身はSecret値を
 *    一度も出力しない。呼び出し元も同じ契約を守ること）。
 * 3. 発行したJWT本体（token文字列）も同様に、標準出力・ログ・一時ファイル・
 *    commit・監査ZIPへ含めない。CLIとして直接実行した場合は、発行成功の事実と
 *    メタデータ（sub・jti・exp）だけを表示し、token自体は一切表示しない。
 * 4. クレームは、確認済みactive accountをsubとし、aud=logInteractionV2Verify・
 *    scope=write:interaction_logs_v2_verify・iat=現在時刻・exp=iat+15分・
 *    ランダムjtiを設定する（既存のsignVerifyJwt()をそのまま再利用し、署名
 *    アルゴリズム自体を複製・再実装しない）。
 */
const { execFileSync } = require('child_process');
const { signVerifyJwt } = require('../lib/funnelV2');

const REQUIRED_ACTIVE_ACCOUNT = 'info@aoki-tosou.net';
const VERIFY_JWT_SECRET_NAME = 'VERIFY_JWT_SECRET';
const VERIFY_JWT_AUD = 'logInteractionV2Verify';
const VERIFY_JWT_SCOPE = 'write:interaction_logs_v2_verify';
const VERIFY_JWT_TTL_SECONDS = 15 * 60;
// Secret Manager上でVERIFY_JWT_SECRETが実在するGCPプロジェクト。ローカルの
// `gcloud config` のデフォルトプロジェクト設定に依存しない（未設定・別プロジェクトを
// 指している環境でも正しく本番プロジェクトを参照できるよう、常に明示指定する）。
const VERIFY_JWT_SECRET_PROJECT = 'aokitosou-miniapp';

/** 実行環境のデフォルト依存（本物のgcloud CLIを呼ぶ）。テストからdepsとして
 * 差し替え可能にするため、呼び出し部分をこの関数へ切り出す。 */
function defaultDeps_() {
  // Windows環境ではgcloudは実体がgcloud.cmdであり、execFileSyncはshell:trueが
  // 無いとENOENT（実行ファイルを解決できない）になる。既存のbuild_copy_test_staging.js
  // がclasp呼び出しで同じ理由からspawnSync(..., {shell:true})を使っているのと
  // 同じ対処（プラットフォーム非依存にするためwin32以外でも明示的にtrueで統一する）。
  const useShell = true;
  // stdio: stdinは使わない・stdout/stderrは明示的にpipeで捕捉する（親プロセスの
  // 標準出力/エラー出力へ何も継承させない。gcloudの診断出力に将来Secret値相当の
  // 情報が混じる可能性を構造的に排除するための防御的な設定）。
  const execOpts = { encoding: 'utf8', shell: useShell, stdio: ['ignore', 'pipe', 'pipe'] };
  return {
    getActiveAccount: function () {
      const out = execFileSync('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], execOpts);
      return String(out || '').trim().split('\n')[0] || '';
    },
    getSecret: function () {
      const out = execFileSync('gcloud', [
        'secrets', 'versions', 'access', 'latest',
        '--secret=' + VERIFY_JWT_SECRET_NAME,
        '--project=' + VERIFY_JWT_SECRET_PROJECT
      ], execOpts);
      return String(out || '').replace(/\r?\n$/, '');
    }
  };
}

/**
 * VERIFY書込みJWTをローカルで発行する。
 * fail-closed: gcloudのactive accountが確認済みの単一アカウント
 * （info@aoki-tosou.net）と完全一致しない限り、Secret Manager呼び出しにすら
 * 進まず例外を投げる（account確認自体の失敗＝ネットワーク断・認証切れ等も
 * 同様にfail-closedで拒否する。「確認できないから許可する」にはしない）。
 * 戻り値のtokenは呼び出し元のメモリ内だけで扱うこと（console.log・ファイル
 * 書き込み・例外メッセージへの埋め込みを一切行わない。このモジュール自身も
 * それらを一切行わない）。
 * @param {object} [deps] テスト用の差し替え依存（getActiveAccount・getSecret）。
 *   省略時は実際のgcloud CLIを呼ぶ（defaultDeps_）。
 * @returns {{token: string, jti: string, exp: number, sub: string}}
 */
function issueVerifyJwtLocal(deps) {
  const d = Object.assign({}, defaultDeps_(), deps || {});

  let account;
  try {
    account = String(d.getActiveAccount() || '').trim();
  } catch (err) {
    throw new Error('fail-closed: gcloud active accountの確認に失敗した。認証状態（gcloud auth list）を確認してから再実行すること。');
  }
  if (account !== REQUIRED_ACTIVE_ACCOUNT) {
    throw new Error('fail-closed: gcloud active accountが確認済みアカウント（' + REQUIRED_ACTIVE_ACCOUNT + '）と一致しない（実際: ' + (account || '(未認証)') + '）。VERIFY JWTの発行を中止する。');
  }

  let secret;
  try {
    secret = d.getSecret();
  } catch (err) {
    // Secret値自体をエラーメッセージへ含めない（gcloudの標準エラーにSecret値が
    // 含まれることは通常無いが、念のためこのモジュール独自の文言だけを使う）。
    throw new Error('fail-closed: Secret Manager（' + VERIFY_JWT_SECRET_NAME + '）の取得に失敗した。認証・IAM権限（Secret Accessor）を確認してから再実行すること。');
  }
  if (!secret) {
    throw new Error('fail-closed: Secret Manager（' + VERIFY_JWT_SECRET_NAME + '）の値が空だった。');
  }

  const signed = signVerifyJwt(secret, {
    sub: account,
    aud: VERIFY_JWT_AUD,
    scope: VERIFY_JWT_SCOPE,
    ttlSeconds: VERIFY_JWT_TTL_SECONDS
  });
  // secret・signed.token自体をここでは一切ログ・ファイルへ出力しない。
  return { token: signed.token, jti: signed.jti, exp: signed.exp, sub: account };
}

if (require.main === module) {
  // CLIとして直接実行された場合：発行の成否・メタデータ（sub・jti・exp）だけを
  // 標準出力へ表示する。JWT本体（token）は絶対に出力しない。
  try {
    const result = issueVerifyJwtLocal();
    console.log('VERIFY JWT発行成功（本体は表示しません）: sub=' + result.sub + ' jti=' + result.jti + ' exp=' + new Date(result.exp * 1000).toISOString());
    process.exitCode = 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  issueVerifyJwtLocal,
  // R9再監査対応・項目3：defaultDeps_を公開する（実gcloud呼び出しを行う実装。
  // 「アカウント確認は本物のgcloudを呼び、Secret Manager取得だけを差し替える」
  // という部分的な統合ハーネス（scripts/verify_jwt_real_issuance_harness.js）が、
  // このモジュール自身のgcloud呼び出しロジックを複製せずに再利用するため）。
  defaultDeps_,
  REQUIRED_ACTIVE_ACCOUNT,
  VERIFY_JWT_SECRET_NAME,
  VERIFY_JWT_AUD,
  VERIFY_JWT_SCOPE,
  VERIFY_JWT_TTL_SECONDS,
  VERIFY_JWT_SECRET_PROJECT
};
