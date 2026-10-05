'use strict';

// 実行: node --test tools/browser-step-panel/step-panel.test.js
// playwright が見つからない環境ではスキップする。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

let playwright = null;
try {
  playwright = require('playwright');
} catch {
  // skip below
}

const { attachStepPanel } = require('./playwright-helper');

const STEPS = ['ログインする', 'プロパティを探す', 'プロパティを作る', '測定IDを控える'];

function startServer() {
  const server = http.createServer((req, res) => {
    const strictCsp = req.url.startsWith('/csp');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      ...(strictCsp ? { 'content-security-policy': "default-src 'none'; script-src 'self'; require-trusted-types-for 'script'" } : {}),
    });
    res.end(`<!doctype html><title>t</title><style>div{color:red!important;font-size:40px!important}</style>
      <button id="corner" style="position:fixed;right:20px;bottom:20px;width:120px;height:40px">corner</button>
      <script>document.getElementById('corner')&&0</script>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function readPanel(page) {
  return page.evaluate(() => {
    const host = document.getElementById('aoki-step-panel-host');
    if (!host) return null;
    const panel = host.shadowRoot.querySelector('.panel');
    const rect = panel.getBoundingClientRect();
    return {
      className: panel.className,
      count: panel.querySelector('.count')?.textContent ?? null,
      items: [...panel.querySelectorAll('li')].map((li) => `${li.className}:${li.textContent}`),
      message: panel.querySelector('.message').hidden ? null : panel.querySelector('.message').textContent,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      width: rect.width,
      color: getComputedStyle(panel.querySelector('li')).fontSize,
    };
  });
}

test('手順パネル', { skip: !playwright && 'playwright 未インストール' }, async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await playwright.chromium.launch();
  t.after(async () => {
    await browser.close();
    server.close();
  });

  await t.test('右下に表示し、手順・現在位置・入力待ちメッセージを出す', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const panel = await attachStepPanel(context);
    await page.goto(`${base}/`);

    assert.equal(await readPanel(page), null, 'show 前は出さない');

    await panel.show({ task: 'GA4 を入れる', steps: STEPS });
    await panel.next();
    await panel.next();
    await panel.ask('プロパティを作るアカウントを決めます。チャットで教えてください。');

    const p = await readPanel(page);
    assert.match(p.className, /waiting/);
    assert.equal(p.count, '3／4');
    assert.deepEqual(p.items, ['done:✓ログインする', 'done:✓プロパティを探す', 'current:▶プロパティを作る', 'todo:・測定IDを控える']);
    assert.equal(p.message, 'プロパティを作るアカウントを決めます。チャットで教えてください。');
    assert.equal(Math.round(p.right), 16);
    assert.equal(Math.round(p.bottom), 16);
    assert.notEqual(p.color, '40px', 'ページのCSSが入り込まない');

    // パネルの下にあるボタンもクリックできる（操作の邪魔をしない）
    const clicked = await page.evaluate(() => {
      const r = document.getElementById('corner').getBoundingClientRect();
      return document.elementFromPoint(r.left + 5, r.top + 5)?.id;
    });
    assert.equal(clicked, 'corner');

    // ページ遷移後も同じ表示に戻る
    await page.goto(`${base}/other`);
    assert.deepEqual((await readPanel(page)).items, p.items);

    // 新しいタブにも出る
    const tab = await context.newPage();
    await tab.goto(`${base}/tab`);
    assert.equal((await readPanel(tab)).count, '3／4');

    await panel.next();
    await panel.next();
    const done = await readPanel(page);
    assert.match(done.className, /done/);
    assert.ok(done.items.every((i) => i.startsWith('done:')));
    assert.equal((await readPanel(tab)).className, done.className, 'タブ間で表示が揃う');

    await page.screenshot({ path: path.join(process.env.STEP_PANEL_SHOT_DIR || require('node:os').tmpdir(), 'step-panel-done.png') });

    await panel.hide();
    assert.equal(await readPanel(page), null);
    await context.close();
  });

  await t.test('厳しいCSP・Trusted Types のページでも出る', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const panel = await attachStepPanel(context);
    await page.goto(`${base}/csp`);
    await panel.show({ task: 'CSP', steps: ['a', 'b'] });
    assert.equal((await readPanel(page)).count, '1／2');
    await context.close();
  });

  await t.test('attach 前から開いていたページにも出る', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/before`);
    const panel = await attachStepPanel(context);
    await panel.show({ task: '後付け', steps: ['a'] });
    assert.equal((await readPanel(page)).count, '1／1');
    await context.close();
  });

  await t.test('スマホ幅では画面からはみ出さない', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
    const page = await context.newPage();
    const panel = await attachStepPanel(context);
    await page.goto(`${base}/`);
    await panel.show({ task: 'とても長い作業名'.repeat(10), steps: ['長い手順名'.repeat(20)] });
    const p = await readPanel(page);
    assert.ok(p.width <= 320 - 32 + 0.5, `width=${p.width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await context.close();
  });
});
