(function() {
  'use strict';
  /**
   * Web流入媒体識別精度改善・単位EF：schemaVersion:2クライアントwriter
   * （2026-09-07新規・独立監査「本番BLOCK」対応で訪問境界・outbox契約を全面改訂）。
   * 既存 js/analytics.js（V1・logInteractionエンドポイント）はこのファイルとは無関係に
   * 無変更のまま残り、並行して動作し続ける。
   *
   * 正規化・検証は一切クライアント側で行わない。生値（visitMediaCode / visitWebSource /
   * visitorId / visitorIdPersisted）をそのまま送り、サーバー側（funnelV2.js）が正規化する。
   *
   * --- 訪問境界（独立監査差し戻し対応・確定アルゴリズム） ---
   * 各イベント送信時に、現在ページのfrom／外部referrerから「複合boundaryKey」を計算し、
   * 直前に保存済みのboundaryKeyと比較する。
   *   - 30分の無操作でタイムアウト（新visit）。
   *   - タイムアウト前でも、今回のboundaryKeyが直前と異なり、かつ今回何らかの信号
   *     （from・外部referrerのいずれか）を持つ場合は新visit（fromだけ変化・referrerだけ
   *     変化・両方変化のいずれも対象）。
   *   - 今回のページが信号を一切持たない場合（内部遷移等）は、タイムアウト前なら
   *     現在の帰属をそのまま維持する（推測で上書きしない）。
   *   - 媒体（from）はあるが外部referrerが無い場合：webSource=''／サーバー側status='none'。
   *   - 媒体も外部referrerも無い場合のみ：webSource='direct'（真の直接訪問）。
   *   - 外部referrerがある場合：mediaの有無に関わらずwebSourceへ生のreferrerホストを送る。
   * --- outbox（確定契約） ---
   *   - sendBeaconが成功しても即座には削除しない。次回fetchで2xxが確認できるまで保持する
   *     （sendBeaconは送達を確認できないため）。
   *   - 2xx：削除。400/404/413/422：恒久的に削除（再送しても成功しない）。
   *     403（Origin不許可）：恒久的に削除。408/429/5xx／通信失敗：保持し再送する。
   *   - PROD 401：送信全体を停止（サーキットブレーカー）。永続化されたnextTrialAt
   *     （15→30→60→120分とエスカレート）を過ぎて初めて、outbox最古の1件だけを
   *     試験再送する。ページを新規に開いた時点で無条件に即時試験することはしない
   *     （訂正：独立監査再提出R8・項目10。以前この欄は「15分後、またはページを
   *     新規に開いた時点のいずれか早い方」と記載していたが、これは独立監査
   *     再提出R6・項目9でforce=true即時試験仕様を廃止した際に更新し忘れていた
   *     古い記述であり、実装（nextTrialAt必須のattemptTrialResend）と食い違って
   *     いた。ページ新規表示時もnextTrialAtのチェックを必ず経由する＝待機時間を
   *     無視した即時試験は行わない、が正しい仕様）。成功すれば停止解除。
   *   - 独立監査再提出R8・項目10：401再発の待機エスカレーション回数（trialCount・
   *     上限4回）とは別に、実際にfetchを試みた総回数（結果を問わず＝401・恒久4xx・
   *     一時的失敗・通信エラーすべてを含む）に独立した上限（STOP_TOTAL_ATTEMPT_LIMIT）
   *     を設ける。401以外の失敗（一時的な5xx・通信エラー等）が続く限りtrialCountは
   *     進まず、エスカレーション段階が15分固定のまま実質無制限に試行し続けられる
   *     欠陥を防ぐ（ページ再読込のたびにこの状態を繰り返し得るため、リロードによる
   *     回数上限の実質的な迂回にもなり得た）。この総数上限は401再発かどうかに
   *     関わらず、実際に試行を開始した時点で必ず消費する。
   *   - 再送間隔（保持系の失敗）：1回目失敗=15分後、2回目=30分後、3回目=60分後、
   *     4回目以降=120分後（上限）。24時間経過または50件超過分は破棄し、破棄件数を
   *     診断情報として記録する。
   *   - localStorage/sessionStorageが使えない環境でも、同一ページが生存している間は
   *     メモリ上のvisit_id／visitorIdをそのまま使い回す（ページ内で毎回新規発行しない）。
   */
  try {
    var ENDPOINT = 'https://us-central1-aokitosou-miniapp.cloudfunctions.net/logInteractionV2';
    var WRITER_GENERATION = 2; // 訪問境界・outbox契約を全面改訂したため世代を1→2へ引き上げる
    var VISIT_TIMEOUT_MS = 30 * 60 * 1000;
    var OUTBOX_KEY = 'aoki_analytics_v2_outbox';
    var OUTBOX_DIAG_KEY = 'aoki_analytics_v2_outbox_diag';
    var OUTBOX_MAX_ITEMS = 50;
    var OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    var VISITOR_ID_KEY = 'aoki_analytics_v2_visitor_id';
    var VISIT_STATE_KEY = 'aoki_analytics_v2_visit';
    var STOP_STATE_KEY = 'aoki_analytics_v2_stop_state';
    // 監査差し戻し（独立監査再提出R6）#9：401停止中の試験再送は15→30→60→120分と
    // エスカレートし、最大4回で打ち切る（確定契約）。以前のSTOP_TRIAL_INTERVAL_MSは
    // 15分固定でエスカレートせず、かつattemptTrialResend(force=true)がinit()から
    // 無条件に呼ばれていたため、ページを何度リロードしても15分の待機すら無視して
    // 即時に試験再送が発生し、事実上「無制限試験」になっていた（禁止事項）。
    // 保持系失敗（408/429/5xx/通信失敗）の再送間隔テーブルと同じ値・同じエスカレート
    // 方式を、401停止中の試験再送スケジュールにも流用する（backoffForAttempts()を共用）。
    var RETRY_BACKOFF_MS = [15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000, 120 * 60 * 1000];
    var STOP_TRIAL_MAX_ATTEMPTS = 4; // 401再発の待機エスカレーション回数上限（4回とも401なら自動再試行を打ち切る＝finalStopped）
    // 独立監査再提出R8・項目10：401の待機エスカレーション回数（trialCount。上のSTOP_TRIAL_
    // MAX_ATTEMPTS）とは独立した、実際にfetchを試みた総回数（結果を問わず＝401・恒久4xx・
    // 一時的失敗・通信エラーすべてを含む）に対する上限。trialCountは401再発時にしか
    // 進まないため、401以外の失敗（一時的な5xx・通信エラー等）だけが続く限り、
    // エスカレーション段階が15分固定のまま実質無制限に試行し続けられてしまう
    // （ページ再読込を挟むかどうかに関わらず発生し得るが、この状態はページ再読込の
    // たびに再現しやすい＝「無制限ポーリング／リロードによる回数上限の迂回」と
    // 同じ実害になる）。この総数上限は、401再発かどうかに関わらず、実際に試行を
    // 開始した時点で必ず1つ消費し、上限に達したら以後の自動試験を一切行わない
    // （finalStopped=true。QAのresumeAfterStop()による手動解除のみが復帰手段）。
    var STOP_TOTAL_ATTEMPT_LIMIT = 20;
    var PERMANENT_DELETE_STATUSES = [400, 404, 413, 422, 403];
    var RETRYABLE_STATUSES = [408, 429];

    // --- ページ生存中のメモリフォールバック（storage不能時でも同一ページ内は使い回す） ---
    var memoryVisitState = null;
    var memoryVisitorId = null;
    var memoryStopState = null;

    function safeLocalGet(key) { try { return window.localStorage.getItem(key); } catch (err) { return null; } }
    function safeLocalSet(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (err) { return false; } }
    /** 監査差し戻し（独立監査再提出R8）#5：setItem()が例外を投げなかっただけでは
     * 「実際に永続化された」ことの証明にならない（一部のブラウザ・プライバシー
     * モード・サードパーティストレージ分割・クォータ超過の一部実装等では、
     * 例外を投げずに書き込みを黙って無視することがある）。setItem直後に同じキーを
     * getItem()で読み戻し、書き込んだ値と完全一致した場合だけtrueを返す。
     * 読戻し不一致・null・例外はいずれもfalse（＝呼び出し元はvisitorIdPersisted=false
     * として扱う。この値はサーバー側のhashReliable算出にそのまま使われる契約）。 */
    function safeLocalSetVerified(key, value) {
      try {
        window.localStorage.setItem(key, value);
        return window.localStorage.getItem(key) === value;
      } catch (err) { return false; }
    }
    function safeSessionGet(key) { try { return window.sessionStorage.getItem(key); } catch (err) { return null; } }
    function safeSessionSet(key, value) { try { window.sessionStorage.setItem(key, value); return true; } catch (err) { return false; } }

    function nowMs() { return Date.now(); }

    function randomToken() {
      try {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
      } catch (err) {}
      return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }

    function safeHref() { try { return window.location.href; } catch (err) { return ''; } }

    /* ---- visitorId（長期・localStorage。不能時はページ内メモリを使い回す） ---- */
    /** 監査差し戻し（独立監査再提出R8）#5：この関数が生成するvisitorIdの形式
     * （'vid2_'+英数字）と一致するかを検証する。既存の保存値も、この形式で
     * なければ「不正」として扱い、そのまま信用せず再発行する（形式不正な残骸
     * ＝別スキーマの値・手動改変等をpersisted=trueの正当な値として扱わない）。 */
    function isValidVisitorId(id) { return typeof id === 'string' && /^vid2_[a-zA-Z0-9]+$/.test(id); }
    function getOrCreateVisitorId() {
      var existing = safeLocalGet(VISITOR_ID_KEY);
      if (existing && isValidVisitorId(existing)) { memoryVisitorId = existing; return { id: existing, persisted: true }; }
      if (memoryVisitorId && isValidVisitorId(memoryVisitorId)) return { id: memoryVisitorId, persisted: false };
      var id = 'vid2_' + randomToken();
      memoryVisitorId = id;
      // 監査差し戻し（独立監査再提出R8）#5：setItem()が例外を投げなかっただけでは
      // 永続化された証拠にならない。読戻し一致を確認したsafeLocalSetVerified()の
      // 結果だけをpersistedとして扱う（読戻し不一致・null・例外はfalse）。
      var persisted = safeLocalSetVerified(VISITOR_ID_KEY, id);
      return { id: id, persisted: persisted };
    }

    /* ---- 現在ページの生信号（from／外部referrer） ---- */
    function currentUrlParams() {
      try { return new URLSearchParams(window.location.search); } catch (err) { return new URLSearchParams(); }
    }
    function currentSignal() {
      var fromParam = null;
      try { var raw = currentUrlParams().get('from'); if (raw) fromParam = raw; } catch (err) {}
      var referrerHost = null;
      try {
        if (document.referrer) {
          var refHost = new URL(document.referrer).hostname.toLowerCase();
          var curHost = window.location.hostname.toLowerCase();
          if (refHost !== curHost) referrerHost = refHost; // 外部（同一originは信号扱いしない）
        }
      } catch (err) {}
      return { from: fromParam, referrerHost: referrerHost };
    }
    /** 信号（from／外部referrer）が一切無ければnull（＝比較対象にしない＝現在帰属を維持）。 */
    function boundaryKeyOf(signal) {
      if (signal.from == null && signal.referrerHost == null) return null;
      return (signal.from || '') + '|' + (signal.referrerHost || '');
    }
    /** 生のvisitMediaCode／visitWebSourceを信号から導出する（サーバー側で正規化される前提）。
     * 媒体あり・外部referrerなし→webSource=''（正本仕様：status='none'）。
     * 媒体も外部referrerも無い→'direct'（真の直接訪問のみ）。
     * 外部referrerがあれば、媒体の有無に関わらず生のreferrerホストを送る。 */
    function rawAttributionFromSignal(signal) {
      var mediaCode = signal.from || '';
      var webSource;
      if (signal.referrerHost) webSource = signal.referrerHost;
      else if (mediaCode) webSource = '';
      else webSource = 'direct';
      return { mediaCode: mediaCode, webSource: webSource };
    }

    /* ---- visit状態（sessionStorage。不能時はページ内メモリを使い回す） ---- */
    function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }
    /** 監査差し戻し（独立監査再提出R8）#4：保存済みvisit状態を使用前に厳格検証する。
     * 以前は「JSON objectか」（typeof===‘object’）しか確認していなかったため、
     * visitId欠損・形式不正な状態（例：sessionStorageの手動編集・別スキーマの
     * 残骸・ストレージ実装のバグ等）でもlastActivityAtさえ新しければそのまま
     * 「現在の訪問」として使い続けてしまい、buildEvent()がその壊れたvisitIdを
     * event.visit_idへそのまま採用していた。V2 writerはvisit_idの形式を検証して
     * おり、不正な形式は400（恒久4xx）で拒否される。sendViaFetchの契約上、400は
     * 「恒久的に削除」（removeFromOutbox）されるため、この壊れたvisitIdを使い続ける
     * 限り、track()のたびに新しいイベントが生成→送信→400→永久削除、を繰り返し、
     * タイムアウト（30分）が来るまでの間、このタブ・このvisitの全イベントが
     * サイレントに失われ続けるという実害のあるバグだった。
     * ここでは以下を全て満たす場合のみ「有効な保存済みvisit状態」として扱う：
     *  - visitId: getOrUpdateVisit()が実際に生成する形式（'vst2_'+英数字）と一致する文字列
     *  - startedAt / lastActivityAt: 有限の正の数値
     *  - mediaCode / webSource / landingPage: 文字列（空文字は許容＝'direct'訪問等で正当）
     *  - boundaryKey: nullまたは文字列（初回訪問が無信号の場合はnullが正当値）
     * 1つでも満たさなければ「無効」とみなし、呼び出し元（loadVisitState）は保存状態を
     * 一切使わない（nullを返す）。getOrUpdateVisit()側は!stateをtimedOut相当として扱う
     * 既存ロジックにより、自動的に新しいvisitIdを発行する（このvisit状態を
     * "legacy"化する処理は一切行わない＝単に新規visitとして扱われるだけ）。 */
    function isValidVisitState(state) {
      if (!state || typeof state !== 'object') return false;
      if (typeof state.visitId !== 'string' || !/^vst2_[a-zA-Z0-9]+$/.test(state.visitId)) return false;
      if (!isFiniteNumber(state.startedAt) || state.startedAt <= 0) return false;
      if (!isFiniteNumber(state.lastActivityAt) || state.lastActivityAt <= 0) return false;
      if (typeof state.mediaCode !== 'string') return false;
      if (typeof state.webSource !== 'string') return false;
      if (state.boundaryKey !== null && typeof state.boundaryKey !== 'string') return false;
      if (typeof state.landingPage !== 'string') return false;
      return true;
    }
    function loadVisitState() {
      try {
        var raw = safeSessionGet(VISIT_STATE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (isValidVisitState(parsed)) return parsed;
          return null; // 破損・不正な保存状態は使わない（壊れたvisitIdを使い回さない）
        }
      } catch (err) {}
      return isValidVisitState(memoryVisitState) ? memoryVisitState : null;
    }
    function saveVisitState(state) {
      memoryVisitState = state;
      safeSessionSet(VISIT_STATE_KEY, JSON.stringify(state));
    }

    /** 訪問境界の確定判定（正本仕様・独立監査再提出R6版）。イベント送信のたびに呼ばれる。 */
    function getOrUpdateVisit() {
      var now = nowMs();
      var state = loadVisitState();
      var signal = currentSignal();
      var key = boundaryKeyOf(signal);
      var timedOut = !state || (now - Number(state.lastActivityAt || 0)) > VISIT_TIMEOUT_MS;

      // 監査差し戻し（独立監査再提出R6）#3特則：直前と同じfromが再度届いたが、
      // 今回は外部referrerが無い（＝信号が「弱くなった」だけで、fromそのものは
      // 変わっていない）場合は境界変化とみなさず、同一訪問を継続する。
      // 境界キー文字列の単純比較だけで判定すると（'meishi|' !== 'meishi|google.com'）、
      // このケースを誤って境界変化と判定し、既にある外部referrer由来のwebSourceを
      // 失って新しい訪問（webSource=''）を始めてしまう。30分のタイムアウトを跨いだ
      // 場合はこの特則を適用しない（timedOut時は下の新規訪問ロジックでwebSource=''の
      // 新しい訪問を正しく開始する＝仕様どおり）。
      var sameFromWeakerSignal = !timedOut && !!state && signal.from != null &&
        signal.from === state.mediaCode && signal.referrerHost == null;
      var keyChanged = !timedOut && !!state && key !== null && key !== state.boundaryKey && !sameFromWeakerSignal;

      if (!timedOut && !keyChanged) {
        // 現在の訪問を維持（信号なし、または信号ありでも直前と同一）。
        state.lastActivityAt = now;
        saveVisitState(state);
        return state;
      }

      // 新しい訪問：境界を切り、今回の信号から帰属を再取得する。
      var attribution = rawAttributionFromSignal(signal);
      var next = {
        visitId: 'vst2_' + randomToken(),
        startedAt: now,
        lastActivityAt: now,
        boundaryKey: key, // nullの場合（初回訪問が無信号）もそのまま保存し、次回signal付きイベントとの比較に使う
        mediaCode: attribution.mediaCode,
        webSource: attribution.webSource,
        landingPage: safeHref()
      };
      saveVisitState(next);
      return next;
    }

    /* ---- outbox ---- */
    function loadOutbox() {
      try {
        var raw = safeLocalGet(OUTBOX_KEY);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) { return []; }
    }
    function saveOutbox(list) { safeLocalSet(OUTBOX_KEY, JSON.stringify(list)); }
    function loadDiagnostics() {
      try {
        var raw = safeLocalGet(OUTBOX_DIAG_KEY);
        var parsed = raw ? JSON.parse(raw) : null;
        return (parsed && typeof parsed === 'object') ? parsed : { expiredDiscardCount: 0 };
      } catch (err) { return { expiredDiscardCount: 0 }; }
    }
    function saveDiagnostics(diag) { safeLocalSet(OUTBOX_DIAG_KEY, JSON.stringify(diag)); }
    function recordExpiredDiscard(count) {
      if (!count) return;
      var diag = loadDiagnostics();
      diag.expiredDiscardCount = Number(diag.expiredDiscardCount || 0) + count;
      saveDiagnostics(diag);
    }

    /** 世代不一致・24時間超過を除去し、最大50件（新しい方を残す）へ切り詰める。
     * 24時間超過で破棄した件数を診断情報として記録する。 */
    function pruneOutbox(list) {
      var now = nowMs();
      var expiredCount = 0;
      var filtered = (list || []).filter(function(item) {
        if (!item || item.generation !== WRITER_GENERATION || !item.event || !item.event.event_id) return false;
        var expired = (now - Number(item.addedAt || 0)) > OUTBOX_MAX_AGE_MS;
        if (expired) expiredCount++;
        return !expired;
      });
      if (expiredCount) recordExpiredDiscard(expiredCount);
      if (filtered.length > OUTBOX_MAX_ITEMS) filtered = filtered.slice(filtered.length - OUTBOX_MAX_ITEMS);
      return filtered;
    }
    function enqueue(event) {
      var list = pruneOutbox(loadOutbox());
      list.push({ generation: WRITER_GENERATION, event: event, addedAt: nowMs(), attempts: 0, nextRetryAt: 0 });
      saveOutbox(pruneOutbox(list));
    }
    function removeFromOutbox(eventId) {
      saveOutbox(loadOutbox().filter(function(item) { return !item.event || item.event.event_id !== eventId; }));
    }
    function updateOutboxItem(eventId, patch) {
      var list = loadOutbox();
      var changed = false;
      list = list.map(function(item) {
        if (item.event && item.event.event_id === eventId) { changed = true; return Object.assign({}, item, patch); }
        return item;
      });
      if (changed) saveOutbox(list);
    }

    /* ---- PROD 401 サーキットブレーカー（確定契約：独立監査再提出R6・項目9、
     * 独立監査再提出R8・項目10でtotalAttemptsを追加） ----
     * 状態は{stoppedAt, trialCount, totalAttempts, nextTrialAt, finalStopped}。
     * trialCountは「401が再発して失敗した回数」（401以外の失敗では進まない。
     * 401の待機エスカレーション＝15→30→60→120分の段階を決めるためだけに使う）。
     * totalAttemptsは「結果を問わず実際にfetchを試みた総回数」（401・恒久4xx・
     * 一時的失敗・通信エラーすべてを含む。trialCountとは独立した安全弁）。
     * 成功していれば即clearStopされ状態自体が消える。nextTrialAtは次に試験して
     * よい時刻（backoffForAttempts()を共用）。trialCountがSTOP_TRIAL_MAX_ATTEMPTS
     * （4）に達するか、totalAttemptsがSTOP_TOTAL_ATTEMPT_LIMIT（20）に達したら、
     * いずれか早い方でfinalStopped=trueとし、nextTrialAtをnullにして以後は自動
     * 試験を一切行わない（QAのresumeAfterStop()による手動解除のみが復帰手段）。
     * この状態はlocalStorage（不可の場合はページ内メモリ）へ永続化されるため、
     * ページを何度リロードしても、この記録済みのtrialCount／totalAttempts／
     * nextTrialAt／finalStoppedを迂回して追加の試験再送を行うことはできない
     * （旧実装のforce=trueバイパスを廃止。R8でtotalAttemptsを追加したことで、
     * 401以外の失敗が続く場合の実質無制限リトライも同様に防ぐ）。 */
    function loadStopState() {
      try {
        var raw = safeLocalGet(STOP_STATE_KEY);
        if (raw) { var parsed = JSON.parse(raw); if (parsed && parsed.stoppedAt) return parsed; }
      } catch (err) {}
      return memoryStopState;
    }
    function saveStopState(state) { memoryStopState = state; safeLocalSet(STOP_STATE_KEY, state ? JSON.stringify(state) : ''); if (!state) { try { window.localStorage.removeItem(STOP_STATE_KEY); } catch (err) {} } }
    function isStopped() { return !!loadStopState(); }
    function beginStop() {
      var now = nowMs();
      saveStopState({ stoppedAt: now, trialCount: 0, totalAttempts: 0, nextTrialAt: now + backoffForAttempts(1), finalStopped: false });
    }
    /** 実際に試験再送を試みて401で失敗した後に呼ぶ：trialCountを1つ進め、上限
     * （4回）に達していればfinalStopped化し、達していなければ次のエスカレート
     * 間隔を設定する。totalAttempts（実試行総数。attemptTrialResend側で既に
     * 加算済み）はここでは変更せず、そのまま引き継ぐ。 */
    function rescheduleTrialAfterFailedAttempt() {
      var state = loadStopState();
      var now = nowMs();
      var priorCount = Number(state && state.trialCount || 0);
      var newCount = priorCount + 1;
      var totalAttempts = Number(state && state.totalAttempts || 0);
      if (newCount >= STOP_TRIAL_MAX_ATTEMPTS) {
        saveStopState({ stoppedAt: state ? state.stoppedAt : now, trialCount: newCount, totalAttempts: totalAttempts, nextTrialAt: null, finalStopped: true });
      } else {
        saveStopState({ stoppedAt: state ? state.stoppedAt : now, trialCount: newCount, totalAttempts: totalAttempts, nextTrialAt: now + backoffForAttempts(newCount + 1), finalStopped: false });
      }
    }
    /** (a) outboxが空で実際には何も試せなかった場合、または (b) 実際に試験再送を
     * 試みたが401以外の理由（恒久4xx・一時的失敗・通信エラー等）で終わった場合に
     * 呼ぶ：trialCount（＝401再発回数）は消費せず、現在のエスカレート段階のまま
     * 次回チェック時刻だけを先送りする。totalAttempts（実試行総数）は
     * attemptTrialResend側で既に加算済みのものをそのまま引き継ぐ（(a)の場合は
     * 実際に試行していないため元々加算されていない）。 */
    function rescheduleTrialWait() {
      var state = loadStopState();
      var now = nowMs();
      var count = Number(state && state.trialCount || 0);
      var totalAttempts = Number(state && state.totalAttempts || 0);
      saveStopState({ stoppedAt: state ? state.stoppedAt : now, trialCount: count, totalAttempts: totalAttempts, nextTrialAt: now + backoffForAttempts(count + 1), finalStopped: false });
    }
    function clearStop() { saveStopState(null); }
    /** QA専用：試験的に即時再開する（trialCount・totalAttempts・finalStoppedを含む状態を完全に破棄する）。 */
    function resumeAfterStop() { clearStop(); }

    /** 監査差し戻し（独立監査再提出R6）#10：この関数が返すイベントに"referrerHost"
     * キーを含めない。サーバー側（recordWebEventV2）はクライアントの生referrerHostを
     * 一切信用せず、既に検証済みのwebSource/webSourceStatusから自前で導出している
     * （webSourceStatus==='referrer'の場合のみ、その検証済みホスト名を使う）ため、
     * クライアントからの重複証跡フィールドは不要かつ有害（実質使われない値を送り続ける
     * ことになる）。前回はこの意図で削除したつもりだったが、実際にはこの関数の返却
     * オブジェクトに"referrerHost: safeReferrerHost()"が残ったままだった（削除漏れ）。
     * 今回、実際に送信payloadから削除し、下のsafeReferrerHost()自体も呼び出し元が
     * 無くなったため削除した。 */
    function buildEvent(eventType, extra) {
      var visit = getOrUpdateVisit();
      var visitor = getOrCreateVisitorId();
      var event = {
        schemaVersion: 2,
        event_id: 'evt2_' + randomToken(),
        visit_id: visit.visitId,
        occurredAt: nowMs(),
        eventType: eventType,
        visitMediaCode: visit.mediaCode,
        visitWebSource: visit.webSource,
        visitorId: visitor.id,
        visitorIdPersisted: visitor.persisted,
        currentPage: safeHref(),
        landingPage: visit.landingPage || safeHref(),
        contactChannel: ''
      };
      if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) event[k] = extra[k]; } }
      return event;
    }

    function classifyResponseStatus(status) {
      if (status >= 200 && status < 300) return 'success';
      if (status === 401) return 'stop';
      if (PERMANENT_DELETE_STATUSES.indexOf(status) >= 0) return 'permanent';
      if (RETRYABLE_STATUSES.indexOf(status) >= 0 || status >= 500) return 'retry';
      return 'retry'; // 未知のステータスは安全側（保持・再送）に倒す
    }
    function backoffForAttempts(attempts) {
      var idx = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1);
      return RETRY_BACKOFF_MS[idx];
    }

    /** 単一イベントをfetchで送信し、応答に応じてoutboxを更新する（確定契約）。 */
    function sendViaFetch(item, onSettled) {
      if (typeof window.fetch !== 'function') { if (onSettled) onSettled('skipped'); return; }
      var event = item.event;
      try {
        window.fetch(ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event), keepalive: true
        }).then(function(res) {
          var kind = classifyResponseStatus(res ? res.status : 0);
          if (kind === 'success') {
            removeFromOutbox(event.event_id);
          } else if (kind === 'stop') {
            // 監査差し戻し（独立監査再提出R6）#9：既に停止中（＝これがattemptTrialResend経由の
            // 試験再送）であれば、ここでbeginStop()を呼び直さない。呼び直すとtrialCount・
            // エスカレート段階（15/30/60/120分）がリセットされ、上限4回が実質無効化される。
            // 停止状態の前進（trialCountを進める・上限判定）は呼び出し側
            // （attemptTrialResendのonSettled → rescheduleTrialAfterFailedAttempt）が行う。
            // 初回401（まだ停止していない状態からの通常送信）のときだけ、ここで新規に停止する。
            if (!isStopped()) beginStop(); // itemはoutboxに残す（次回の試験再送対象）
          } else if (kind === 'permanent') {
            removeFromOutbox(event.event_id);
          } else {
            var attempts = Number(item.attempts || 0) + 1;
            updateOutboxItem(event.event_id, { attempts: attempts, nextRetryAt: nowMs() + backoffForAttempts(attempts) });
          }
          if (onSettled) onSettled(kind);
        }).catch(function() {
          var attempts = Number(item.attempts || 0) + 1;
          updateOutboxItem(event.event_id, { attempts: attempts, nextRetryAt: nowMs() + backoffForAttempts(attempts) });
          if (onSettled) onSettled('network_error');
        });
      } catch (err) {
        // 監査差し戻し（独立監査再提出R7）#5：window.fetch(...)の呼び出し自体が同期的に
        // 例外を投げた場合（.then/.catchへ到達する前の失敗。CSP違反等で稀に発生し得る）も、
        // 非同期の.catch()分岐と同じくattempts/nextRetryAtを更新する。以前はここが未更新の
        // ままonSettled('exception')だけを呼んでおり、このitemの通常再送スケジュール
        // （backoffForAttempts）が一切進まないまま取り残される欠陥だった。
        var attempts = Number(item.attempts || 0) + 1;
        updateOutboxItem(event.event_id, { attempts: attempts, nextRetryAt: nowMs() + backoffForAttempts(attempts) });
        if (onSettled) onSettled('exception');
      }
    }

    /** 離脱時専用：sendBeaconで送るが、成功してもoutboxからは削除しない
     * （送達確認ができないため。次回ページ表示時のfetch再送で2xxを確認してから削除する）。 */
    function sendViaBeaconBestEffort(event) {
      try {
        if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
        // 監査差し戻し（独立監査再提出R7）#6：ENDPOINTはサイト（aoki-tosou.net）とは別オリジン
        // （...cloudfunctions.net）のため、sendBeacon()は必ずcross-originのリクエストになる。
        // sendBeacon()はpreflight（OPTIONS）を一切行えない設計のため、Blobのtypeを
        // 'application/json'にすると、ブラウザによってはCORS safelisted値ではない
        // Content-Typeとして扱われ、cross-origin時に送信内容や到達性が不安定になり得る。
        // サーバー（parseRequestBody・handleV2Wireのcontent-typeチェック）は元々
        // 'text/plain'も明示的に許容している（V2_MAX_BODY_BYTES等のcontent-typeチェックが
        // application/jsonとtext/plainの両方をOKとする設計）ため、CORS safelistedな
        // 'text/plain'へ変更する（実際の送信内容＝JSON文字列は無変更。Content-Type表示だけ
        // 変える）。既存の実務手法（Google Analytics等の主要な計測クライアントが
        // 同じ理由でsendBeaconにtext/plainを使う）と同じ対処。
        var blob = new Blob([JSON.stringify(event)], { type: 'text/plain' });
        return navigator.sendBeacon(ENDPOINT, blob);
      } catch (err) { return false; }
    }

    function track(eventType, extra) {
      var event = buildEvent(eventType, extra);
      enqueue(event);
      if (isStopped()) return; // outboxには積むが、停止中は送信を試みない（次回の試験再送・復帰を待つ）
      sendViaFetch({ event: event, attempts: 0 });
    }

    /** 通常時：保持中のoutboxのうち、再送猶予（nextRetryAt）を過ぎたものだけをfetchで送る。 */
    function flushOutboxViaFetch() {
      if (isStopped()) return;
      var now = nowMs();
      pruneOutbox(loadOutbox()).forEach(function(item) {
        if (Number(item.nextRetryAt || 0) <= now) sendViaFetch(item);
      });
    }

    /** 停止中：outbox最古の1件だけを試験再送する。エスカレートするnextTrialAtを
     * 過ぎている場合にのみ試みる（呼び出しごとに毎回チェックする＝ページ表示のたび・
     * track()実行のたびに呼んでよい設計）。
     * 監査差し戻し（独立監査再提出R6）#9：以前存在したforce引数（ページ新規表示時に
     * 15分待機を無視して即時試験する）は廃止した。これがあると、ページを繰り返し
     * リロードするたびに待機時間を無視した即時試験再送が発生し、15/30/60/120分への
     * エスカレート・4回上限のいずれも実質的に無意味化する（「無制限試験」で禁止事項）。
     * 廃止後は、この関数はいつ・何度呼ばれても、永続化されたnextTrialAt／trialCount／
     * finalStoppedの記録だけを見て判定するため、ページリロードによる回数制限の
     * バイパスができない。 */
    function attemptTrialResend() {
      var stopState = loadStopState();
      if (!stopState || stopState.finalStopped) return; // 上限到達後は自動試験を一切行わない（QAのresumeAfterStop()のみが復帰手段）
      var now = nowMs();
      if (now < Number(stopState.nextTrialAt || 0)) return;
      var list = pruneOutbox(loadOutbox());
      if (!list.length) { rescheduleTrialWait(); return; } // 送るものが無い＝実際には試行していないのでtrialCountは消費しない
      // 独立監査再提出R8・項目10：実際にfetchを試みる直前に、401再発かどうかとは
      // 無関係な「結果を問わない総試行回数」（totalAttempts）の上限を独立にチェックする。
      // 401以外の失敗（一時的な5xx・通信エラー等）が続く限りtrialCountは進まないため、
      // これが無いとエスカレーション段階が15分固定のまま実質無制限に試行し続けられて
      // しまう（無制限ポーリング・ページ再読込による回数上限の迂回と同じ実害）。
      // 上限に達している場合は、今回は試行そのものを行わずfinalStopped化する
      // （401のtrialCount上限到達時と同じ扱い＝以後は自動試験を一切行わない）。
      var totalAttempts = Number(stopState.totalAttempts || 0);
      if (totalAttempts >= STOP_TOTAL_ATTEMPT_LIMIT) {
        saveStopState(Object.assign({}, stopState, { nextTrialAt: null, finalStopped: true }));
        return;
      }
      saveStopState(Object.assign({}, stopState, { totalAttempts: totalAttempts + 1 }));
      var oldest = list.reduce(function(a, b) { return Number(a.addedAt) <= Number(b.addedAt) ? a : b; });
      sendViaFetch(oldest, function(kind) {
        if (kind === 'success') { clearStop(); flushOutboxViaFetch(); }
        else if (kind === 'stop') {
          // 監査差し戻し（独立監査再提出R7）#5：401（認可拒否）の再発だけがtrialCountを
          // 進める（15/30/60/120分・上限4回の対象）。恒久4xx・一時的失敗・通信エラーは
          // 401の試行回数を消費しない（下のelse節）。
          rescheduleTrialAfterFailedAttempt();
        } else {
          // 監査差し戻し（独立監査再提出R7）#5：恒久4xx（400/403/404/413/422。sendViaFetch
          // 側で最古エントリ自体は既に削除済み）・一時的失敗（408/429/5xx・network_error・
          // exception。エントリはsendViaFetch側で保持・per-item再送スケジュール更新済み）は、
          // 401の認可問題とは無関係のため、trialCountを進めない・エスカレートしない
          // （rescheduleTrialAfterFailedAttempt()を呼ばない）。停止状態自体は維持し、
          // 次回はrescheduleTrialWait()と同じ非エスカレートの間隔で、次の最古エントリ
          // （恒久4xxで削除済みなら別のエントリ、一時的失敗ならそのままのエントリを
          // 含む現在のoutbox）を試す。
          rescheduleTrialWait();
        }
      });
    }

    /** 離脱時：fetchのthenを待てないため、可能な限りsendBeaconで送る（削除はしない）。 */
    function flushOutboxViaBeacon() {
      pruneOutbox(loadOutbox()).forEach(function(item) { sendViaBeaconBestEffort(item.event); });
    }

    function isLineUrl(href) {
      try { var host = new URL(href, safeHref()).hostname; return host === 'line.me' || host.slice(-8) === '.line.me'; } catch (err) { return false; }
    }
    function bindClicks() {
      document.addEventListener('click', function(event) {
        try {
          var link = event.target.closest && event.target.closest('a[href]');
          if (!link) return;
          var href = link.getAttribute('href') || '';
          if (isLineUrl(href)) return track('line_click', { contactChannel: 'LINE' });
          if (href.toLowerCase().indexOf('tel:') === 0) track('phone_click', { contactChannel: '電話' });
        } catch (err) {}
      }, true);
    }

    function init() {
      saveOutbox(pruneOutbox(loadOutbox()));
      // 監査差し戻し（独立監査再提出R6）#9：以前はattemptTrialResend(true)でforce=trueを
      // 渡し、ページ新規表示のたびに待機時間を無視した即時試験再送を行っていた
      // （「無制限試験」で禁止事項）。force引数は廃止し、永続化されたnextTrialAtを
      // 過ぎている場合にのみ試験する（attemptTrialResend内部で判定する）。
      if (isStopped()) attemptTrialResend();
      else flushOutboxViaFetch();
      track('page_view');
      bindClicks();
      try {
        document.addEventListener('visibilitychange', function() {
          if (document.visibilityState === 'hidden') flushOutboxViaBeacon();
        });
      } catch (err) {}
      try { window.addEventListener('pagehide', flushOutboxViaBeacon); } catch (err) {}
    }

    init();

    window.aokiAnalyticsV2 = {
      track: track,
      resumeAfterStop: resumeAfterStop, // QA専用：401サーキットブレーカーの試験的即時解除
      isStopped: isStopped,
      getDiagnostics: loadDiagnostics,
      _internal: {
        buildEvent: buildEvent, getOrUpdateVisit: getOrUpdateVisit, currentSignal: currentSignal,
        boundaryKeyOf: boundaryKeyOf, rawAttributionFromSignal: rawAttributionFromSignal,
        isValidVisitState: isValidVisitState, loadVisitState: loadVisitState, saveVisitState: saveVisitState,
        getOrCreateVisitorId: getOrCreateVisitorId, isValidVisitorId: isValidVisitorId,
        pruneOutbox: pruneOutbox, loadOutbox: loadOutbox, enqueue: enqueue,
        classifyResponseStatus: classifyResponseStatus, backoffForAttempts: backoffForAttempts,
        attemptTrialResend: attemptTrialResend, flushOutboxViaFetch: flushOutboxViaFetch,
        loadStopState: loadStopState, beginStop: beginStop,
        rescheduleTrialAfterFailedAttempt: rescheduleTrialAfterFailedAttempt, rescheduleTrialWait: rescheduleTrialWait,
        WRITER_GENERATION: WRITER_GENERATION, VISIT_TIMEOUT_MS: VISIT_TIMEOUT_MS,
        OUTBOX_MAX_ITEMS: OUTBOX_MAX_ITEMS, OUTBOX_MAX_AGE_MS: OUTBOX_MAX_AGE_MS,
        STOP_TRIAL_MAX_ATTEMPTS: STOP_TRIAL_MAX_ATTEMPTS, STOP_TOTAL_ATTEMPT_LIMIT: STOP_TOTAL_ATTEMPT_LIMIT, RETRY_BACKOFF_MS: RETRY_BACKOFF_MS,
        ENDPOINT: ENDPOINT
      }
    };
  } catch (err) {}
})();
