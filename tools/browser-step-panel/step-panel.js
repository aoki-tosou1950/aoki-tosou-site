/*
 * 手順パネル（ブラウザ操作中に画面右下へ表示する進行状況パネル）
 *
 * AIがブラウザを操作している間、「いま何をしているか」「全体の何手目か」
 * 「人間に何をしてほしいか」を右下に出す。公開サイトからは読み込まない。
 * Playwright なら playwright-helper.js、Claude in Chrome 等ならこのファイルを
 * そのままページで実行してから window.AokiStepPanel を呼ぶ。
 *
 *   AokiStepPanel.show({
 *     task: 'GA4 を入れる',
 *     steps: ['ログインする', 'プロパティを探す', 'プロパティを作る', '測定IDを控える'],
 *     current: 2,                 // 0始まり。これより前は完了扱い
 *     message: 'プロパティを作るアカウントを決めます。チャットで教えてください。',
 *     status: 'waiting',          // working | waiting | done | error
 *   });
 *   AokiStepPanel.next();         // 次の手順へ
 *   AokiStepPanel.hide();
 *
 * 操作の邪魔をしないよう、パネルはクリックを素通しする（pointer-events: none）。
 * ホストページのCSSに影響しない/されないよう Shadow DOM に描画する。
 */
(function () {
  'use strict';

  if (window.AokiStepPanel && window.AokiStepPanel.__version) return;

  var HOST_ID = 'aoki-step-panel-host';
  var STATUS_LABEL = {
    working: 'AIが操作しています',
    waiting: 'あなたの入力を待っています',
    done: '完了しました',
    error: '止まりました',
  };

  var state = {
    visible: false,
    task: '',
    steps: [],
    current: 0,
    message: '',
    status: 'working',
    position: 'bottom-right',
  };

  var CSS = [
    ':host{all:initial}',
    '.panel{',
    '  --bg:#ffffff;--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb;',
    '  --accent:#1a5fb4;--accent-bg:#e8f0fb;--warn:#9a5b00;--warn-bg:#fff4e0;',
    '  --ok:#1a7f37;--err:#b42318;',
    '  position:fixed;z-index:2147483647;bottom:16px;right:16px;',
    '  width:288px;max-width:calc(100vw - 32px);box-sizing:border-box;',
    '  padding:12px 14px;border-radius:12px;border:1px solid var(--line);',
    '  background:var(--bg);color:var(--fg);',
    '  box-shadow:0 8px 24px rgba(0,0,0,.18);',
    '  font:13px/1.5 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP","Yu Gothic UI",sans-serif;',
    '  pointer-events:none;user-select:none;',
    '}',
    '.panel.left{right:auto;left:16px}',
    '@media (prefers-color-scheme:dark){.panel{',
    '  --bg:#1f2328;--fg:#e6edf3;--muted:#9aa4b2;--line:#3a4049;',
    '  --accent:#7cb2ff;--accent-bg:#1d3354;--warn:#f0b35a;--warn-bg:#3a2c12;',
    '  --ok:#57c46e;--err:#ff7b72;}}',
    '.status{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}',
    '.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}',
    '.working .dot{animation:pulse 1.2s ease-in-out infinite}',
    '.waiting .dot{background:var(--warn)}',
    '.done .dot{background:var(--ok)}',
    '.error .dot{background:var(--err)}',
    '@keyframes pulse{50%{opacity:.25}}',
    '@media (prefers-reduced-motion:reduce){.working .dot{animation:none}}',
    '.title{display:flex;gap:8px;align-items:baseline;margin:4px 0 8px;font-size:14px;font-weight:700}',
    '.count{font-variant-numeric:tabular-nums;color:var(--muted);font-weight:600;flex:none}',
    '.task{overflow-wrap:anywhere}',
    'ol{list-style:none;margin:0;padding:0}',
    'li{display:flex;gap:6px;padding:3px 6px;border-radius:6px;color:var(--fg);overflow-wrap:anywhere}',
    'li .mark{width:1em;flex:none;text-align:center}',
    'li.done{color:var(--muted)}',
    'li.done .mark{color:var(--ok)}',
    'li.current{background:var(--accent-bg);color:var(--accent);font-weight:700}',
    '.message{margin-top:8px;padding-top:8px;border-top:1px solid var(--line);overflow-wrap:anywhere}',
    '.waiting .message{background:var(--warn-bg);color:var(--warn);border:0;border-radius:6px;padding:6px 8px;font-weight:600}',
    '.error .message{color:var(--err)}',
    '[hidden]{display:none!important}',
  ].join('\n');

  var host = null;
  var root = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function ensureHost() {
    if (host && host.isConnected) return true;
    var parent = document.documentElement;
    if (!parent) return false;
    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-aoki-step-panel', '');
      parent.appendChild(host);
    }
    root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    return true;
  }

  function clampCurrent(value, length) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    n = Math.floor(n);
    if (n < 0) n = 0;
    if (n > length) n = length;
    return n;
  }

  function render() {
    if (!state.visible) {
      if (host) host.remove();
      host = null;
      root = null;
      return;
    }
    if (!ensureHost()) return;

    var steps = state.steps;
    var status = STATUS_LABEL[state.status] ? state.status : 'working';
    var current = clampCurrent(state.current, steps.length);

    var panel = el('div', 'panel ' + status + (state.position === 'bottom-left' ? ' left' : ''));
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');

    var head = el('div', 'status');
    head.appendChild(el('span', 'dot'));
    head.appendChild(el('span', null, STATUS_LABEL[status]));
    panel.appendChild(head);

    var title = el('div', 'title');
    if (steps.length) {
      var shown = Math.min(current + 1, steps.length);
      title.appendChild(el('span', 'count', shown + '／' + steps.length));
    }
    title.appendChild(el('span', 'task', state.task));
    title.hidden = !state.task && !steps.length;
    panel.appendChild(title);

    if (steps.length) {
      var list = el('ol');
      steps.forEach(function (label, i) {
        var kind = i < current || status === 'done' ? 'done' : i === current ? 'current' : 'todo';
        var item = el('li', kind);
        item.appendChild(el('span', 'mark', kind === 'done' ? '✓' : kind === 'current' ? '▶' : '・'));
        item.appendChild(el('span', null, String(label)));
        if (kind === 'current') item.setAttribute('aria-current', 'step');
        list.appendChild(item);
      });
      panel.appendChild(list);
    }

    var message = el('div', 'message', state.message);
    message.hidden = !state.message;
    panel.appendChild(message);

    root.textContent = '';
    var style = el('style', null, CSS);
    root.appendChild(style);
    root.appendChild(panel);
  }

  function apply(partial) {
    partial = partial || {};
    if (Array.isArray(partial.steps)) state.steps = partial.steps.map(String);
    ['task', 'message', 'status', 'position'].forEach(function (key) {
      if (partial[key] != null) state[key] = String(partial[key]);
    });
    if (partial.current != null) state.current = clampCurrent(partial.current, state.steps.length);
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  var api = {
    __version: 1,
    /** パネルを表示する。渡さなかった項目は直前の値を引き継ぐ。 */
    show: function (options) {
      options = options || {};
      if (Array.isArray(options.steps) && options.current == null) options.current = 0;
      if (options.message == null && (options.steps || options.task)) options.message = '';
      if (options.status == null) options.status = 'working';
      apply(options);
      state.visible = true;
      render();
      return snapshot();
    },
    /** 一部だけ書き換える（表示中でなければ表示はしない）。 */
    update: function (partial) {
      apply(partial);
      render();
      return snapshot();
    },
    /** 次の手順へ進む。最後まで進んだら完了表示にする。 */
    next: function (message) {
      state.current = clampCurrent(state.current + 1, state.steps.length);
      state.status = state.current >= state.steps.length ? 'done' : 'working';
      state.message = message != null ? String(message) : '';
      render();
      return snapshot();
    },
    /** 人間の入力待ちにする（例：「チャットで教えてください」）。 */
    ask: function (message) {
      return api.update({ status: 'waiting', message: message });
    },
    done: function (message) {
      return api.update({ status: 'done', current: state.steps.length, message: message == null ? '' : message });
    },
    error: function (message) {
      return api.update({ status: 'error', message: message });
    },
    hide: function () {
      state.visible = false;
      render();
      return snapshot();
    },
    getState: snapshot,
    /** 別ページへ移ったあとに状態を復元する（Playwright ヘルパーが使う）。 */
    restore: function (saved) {
      if (!saved) return snapshot();
      apply(saved);
      state.visible = !!saved.visible;
      render();
      return snapshot();
    },
  };

  window.AokiStepPanel = api;

  // SPA がルート要素を差し替えてパネルが消えた場合に描き直す。
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function () {
      if (state.visible && (!host || !host.isConnected)) render();
    }).observe(document, { childList: true, subtree: true });
  }
})();
