'use strict';

/*
 * Playwright 用：BrowserContext に手順パネルを常駐させる。
 *
 *   const { attachStepPanel } = require('./tools/browser-step-panel/playwright-helper');
 *   const panel = await attachStepPanel(context);
 *   await panel.show({ task: 'GA4 を入れる', steps: [...] });
 *   await panel.next();
 *   await panel.ask('プロパティを作るアカウントを決めます。チャットで教えてください。');
 *
 * 状態は Node 側で持ち、ページ遷移・新しいタブでも同じ表示を復元する。
 */

const fs = require('node:fs');
const path = require('node:path');

const PANEL_SOURCE = fs.readFileSync(path.join(__dirname, 'step-panel.js'), 'utf8');
const BINDING = '__aokiStepPanelSavedState';

async function attachStepPanel(context) {
  let saved = null;

  await context.exposeBinding(BINDING, () => saved);
  await context.addInitScript({
    content: `${PANEL_SOURCE}
;(function () {
  var load = function () {
    if (typeof window.${BINDING} !== 'function') return;
    window.${BINDING}().then(function (s) { if (s) window.AokiStepPanel.restore(s); }).catch(function () {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();`,
  });

  async function call(method, arg) {
    const pages = context.pages();
    let result = null;
    for (const page of pages) {
      try {
        // addInitScript 前に開いていたページにも読み込む（文字列評価はページのCSPを受けない）。
        if (!(await page.evaluate(() => !!window.AokiStepPanel))) await page.evaluate(PANEL_SOURCE);
        // どのタブも同じ状態から操作し、表示を揃える。
        const state = await page.evaluate(
          ([m, a, s]) => {
            if (s) window.AokiStepPanel.restore(s);
            return window.AokiStepPanel[m](a);
          },
          [method, arg === undefined ? null : arg, saved],
        );
        result = result || state;
      } catch {
        // 遷移中・閉じかけのページは次の読み込みで init script が復元する。
      }
    }
    if (result) saved = result;
    return saved;
  }

  return {
    show: (options) => call('show', options),
    update: (partial) => call('update', partial),
    next: (message) => call('next', message),
    ask: (message) => call('ask', message),
    done: (message) => call('done', message),
    error: (message) => call('error', message),
    hide: () => call('hide'),
    getState: () => saved,
  };
}

module.exports = { attachStepPanel };
