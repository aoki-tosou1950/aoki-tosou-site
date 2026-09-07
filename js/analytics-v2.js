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
    // 独立監査再提出R9再監査対応・項目2：outbox＋PROD 401サーキットブレーカーは
    // js/analytics-v2-outbox-engine.jsへ共通化した（js/analytics-v2-drain-only.jsと
    // 同じエンジンを呼ぶ。停止処理を2箇所で独立実装して食い違わせない）。このファイルは
    // HTML側でjs/analytics-v2-outbox-engine.jsより後に読み込まれる必要がある
    // （window.__aokiAnalyticsV2OutboxEngineFactory_が未定義ならエンジン未ロード＝
    // 即座に例外→上位try/catchでフェイルソフト。docs/v1-v2-analytics-switch.md参照）。
    var engine = window.__aokiAnalyticsV2OutboxEngineFactory_();
    var ENDPOINT = engine.ENDPOINT;
    var WRITER_GENERATION = engine.WRITER_GENERATION; // 訪問境界・outbox契約を全面改訂したため世代を1→2へ引き上げる
    var VISIT_TIMEOUT_MS = 30 * 60 * 1000;
    var VISITOR_ID_KEY = 'aoki_analytics_v2_visitor_id';
    var VISIT_STATE_KEY = 'aoki_analytics_v2_visit';

    // --- ページ生存中のメモリフォールバック（storage不能時でも同一ページ内は使い回す） ---
    var memoryVisitState = null;
    var memoryVisitorId = null;
    // 独立監査再提出R9・項目1：離脱時beaconの対象範囲・重複防止をページ単位の
    // メモリだけで管理する（永続化しない＝ページを離れれば自然に消える。この
    // 集合自体を次ページへ引き継ぐ必要は無い）。
    // pageOriginEventIds：このページの生存中にtrack()で新規発生したevent_idの集合。
    // 離脱時beaconは、この集合に含まれるイベントだけを対象とする（nextRetryAt
    // 猶予中の古い保持系リトライエントリ・別ページ由来のエントリを、離脱を理由に
    // 強制フラッシュしない）。
    var pageOriginEventIds = {};
    // beaconSentEventIds：このページの生存中に既にsendBeaconを試みたevent_idの集合。
    // visibilitychange(hidden)→pagehideが連続しても、同じイベントを二重beacon
    // 送信しない。hidden後に新規発生したイベントは、この集合にまだ無いため、
    // 後続のpagehideで1回だけ送信できる。
    var beaconSentEventIds = {};
    // trialTimerHandle（nextTrialAtまでの単発setTimeoutのハンドル）はR9再監査対応・
    // 項目2でjs/analytics-v2-outbox-engine.jsのengine内部クロージャへ移動した
    // （engine.getTrialTimerHandle_()で参照できる。ここでは保持しない）。

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
    // 独立監査再提出R9・項目4：startedAt/lastActivityAtの未来方向の許容ずれ
    // （クロックスキュー・システム時計のわずかなずれを吸収する）。これを超える
    // 未来時刻は「破損・改ざん・別プロセス由来の異常値」とみなし、保存状態を
    // 破棄して新しいvisitIdを発行する（既存訪問として推測継続しない）。
    var VISIT_STATE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
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
      // 独立監査再提出R9・項目4：startedAt/lastActivityAtの型・有限・正数だけでなく、
      // 時刻としての整合性も検証する。
      if (state.startedAt > state.lastActivityAt) return false; // 開始が最終活動より後は矛盾（壊れた状態）
      var now = nowMs();
      if (state.startedAt > now + VISIT_STATE_FUTURE_TOLERANCE_MS) return false; // 許容幅を超える未来の開始時刻
      if (state.lastActivityAt > now + VISIT_STATE_FUTURE_TOLERANCE_MS) return false; // 許容幅を超える未来の最終活動時刻
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

    /* ---- outbox ＋ PROD 401サーキットブレーカー ----
     * R9再監査対応・項目2で js/analytics-v2-outbox-engine.js へ共通化した
     * （js/analytics-v2-drain-only.js と同じエンジンインスタンス生成コードを呼ぶ。
     * ここでは薄いエイリアスだけを保持し、実装は一切複製しない）。 */
    var loadOutbox = engine.loadOutbox;
    var saveOutbox = engine.saveOutbox;
    var loadDiagnostics = engine.loadDiagnostics;
    var pruneOutbox = engine.pruneOutbox;
    var enqueue = engine.enqueue;
    var removeFromOutbox = engine.removeFromOutbox;
    var updateOutboxItem = engine.updateOutboxItem;
    var loadStopState = engine.loadStopState;
    var isStopped = engine.isStopped;
    var isFinalStopped = engine.isFinalStopped;
    var clearTrialTimer_ = engine.clearTrialTimer_;
    var scheduleTrialTimer_ = engine.scheduleTrialTimer_;
    var beginStop = engine.beginStop;
    var rescheduleTrialAfterFailedAttempt = engine.rescheduleTrialAfterFailedAttempt;
    var rescheduleTrialWait = engine.rescheduleTrialWait;
    var clearStop = engine.clearStop;
    var resumeAfterStop = engine.resumeAfterStop;
    var classifyResponseStatus = engine.classifyResponseStatus;
    var backoffForAttempts = engine.backoffForAttempts;
    var sendViaFetch = engine.sendViaFetch;
    var flushOutboxViaFetch = engine.flushOutboxViaFetch;
    var attemptTrialResend = engine.attemptTrialResend;

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
      // 独立監査再提出R9・項目1：このページで新規発生したイベントとして記録する
      // （離脱時beaconの対象範囲を「現在ページで新規発生したイベント」だけに
      // 限定するため。停止中でも記録自体は行う＝停止解除後に判定材料として使える）。
      pageOriginEventIds[event.event_id] = true;
      if (isStopped()) return; // outboxには積むが、停止中は送信を試みない（次回の試験再送・復帰を待つ）
      sendViaFetch({ event: event, attempts: 0 });
    }

    /** 離脱時：fetchのthenを待てないため、可能な限りsendBeaconで送る（削除はしない）。
     * 独立監査再提出R9・項目1で以下の制約を追加した：
     *  - PROD 401停止中はsendBeaconを一切送らない（送信全体を止めるという停止契約の
     *    趣旨に、401を認識できないbeaconの送信は反する。停止解除は試験再送（fetch）
     *    経由のみで判定する）。
     *  - 対象は「このページで新規発生したイベント」（pageOriginEventIds）だけに限定
     *    する（nextRetryAt猶予中の古い保持系リトライエントリ・別ページ由来の
     *    エントリを、離脱を理由に強制フラッシュしない）。
     *  - 同一event_idを1ページ内で二重beacon送信しない（beaconSentEventIds。
     *    visibilitychange(hidden)→pagehideが連続する典型ケースに対応）。hidden後に
     *    新規発生したイベントは、この集合にまだ無いため後続のpagehideで1回だけ送れる。 */
    function flushOutboxViaBeacon() {
      if (isStopped()) return;
      pruneOutbox(loadOutbox()).forEach(function(item) {
        var eventId = item.event && item.event.event_id;
        if (!eventId) return;
        if (!pageOriginEventIds[eventId]) return;
        if (beaconSentEventIds[eventId]) return;
        beaconSentEventIds[eventId] = true;
        sendViaBeaconBestEffort(item.event);
      });
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
      // 独立監査再提出R9・項目2：ページ読み込み時にattemptTrialResend()を1回だけ
      // 同期的に呼ぶのではなく、scheduleTrialTimer_()でnextTrialAtまでの単発
      // setTimeoutを設定する（reload後も停止状態とnextTrialAtをlocalStorageから
      // 復元し、期限がまだ先ならその時刻まで待ってから発火する＝「期限前reload
      // だけでは試験再送しない」を維持したまま、期限が来た時点でページを再読込
      // しなくても自動的に試験再送されるようにする）。
      if (isStopped()) scheduleTrialTimer_();
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
        flushOutboxViaBeacon: flushOutboxViaBeacon,
        loadStopState: loadStopState, isFinalStopped: isFinalStopped, beginStop: beginStop,
        rescheduleTrialAfterFailedAttempt: rescheduleTrialAfterFailedAttempt, rescheduleTrialWait: rescheduleTrialWait,
        scheduleTrialTimer_: scheduleTrialTimer_, clearTrialTimer_: clearTrialTimer_,
        getTrialTimerHandle_: engine.getTrialTimerHandle_,
        getPageOriginEventIds_: function() { return pageOriginEventIds; },
        getBeaconSentEventIds_: function() { return beaconSentEventIds; },
        WRITER_GENERATION: WRITER_GENERATION, VISIT_TIMEOUT_MS: VISIT_TIMEOUT_MS,
        OUTBOX_MAX_ITEMS: engine.OUTBOX_MAX_ITEMS, OUTBOX_MAX_AGE_MS: engine.OUTBOX_MAX_AGE_MS,
        STOP_TRIAL_MAX_ATTEMPTS: engine.STOP_TRIAL_MAX_ATTEMPTS, STOP_TOTAL_ATTEMPT_LIMIT: engine.STOP_TOTAL_ATTEMPT_LIMIT, RETRY_BACKOFF_MS: engine.RETRY_BACKOFF_MS,
        VISIT_STATE_FUTURE_TOLERANCE_MS: VISIT_STATE_FUTURE_TOLERANCE_MS,
        ENDPOINT: ENDPOINT,
        engine_: engine
      }
    };
  } catch (err) {}
})();
