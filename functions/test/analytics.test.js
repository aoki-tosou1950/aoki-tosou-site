'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const script = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'analytics.js'), 'utf8');

function browser(url, referrer = '', storage = new Map()) {
  const beacons = [];
  let clickHandler;
  class FakeBlob {
    constructor(parts) { this.text = parts.join(''); }
  }
  const location = new URL(url);
  const document = {
    referrer,
    addEventListener(type, handler) { if (type === 'click') clickHandler = handler; },
    createElement() { return { textContent: '', get innerHTML() { return this.textContent; } }; }
  };
  const context = {
    URL,
    URLSearchParams,
    Blob: FakeBlob,
    Date,
    Math,
    JSON,
    Promise,
    window: {
      location,
      localStorage: { getItem(key) { return storage.get(key) || null; }, setItem(key, value) { storage.set(key, value); } },
      crypto: { randomUUID() { return '12345678-1234-1234-1234-123456789abc'; } },
      fetch() { return Promise.resolve({ ok: true }); }
    },
    document,
    navigator: { sendBeacon(endpoint, blob) { beacons.push({ endpoint, body: JSON.parse(blob.text) }); return true; } }
  };
  context.window.document = document;
  context.window.navigator = context.navigator;
  vm.runInNewContext(script, context);
  return {
    beacons,
    storage,
    click(href) {
      const link = { href, getAttribute() { return href; } };
      clickHandler({ target: { closest() { return link; } } });
      return link;
    }
  };
}

test('ページ表示で訪問・PVイベントを送る', () => {
  const result = browser('https://aoki-tosou.net/?utm_source=google&utm_medium=organic');
  assert.equal(result.beacons.length, 1);
  assert.equal(result.beacons[0].body.event_type, 'page_view');
  assert.equal(result.beacons[0].body.source, 'google / organic');
  assert.match(result.beacons[0].body.visitor_id, /^v_/);
});

test('LINE CTAクリックを送る', () => {
  const result = browser('https://aoki-tosou.net/?from=flyer_general_v1');
  result.click('https://page.line.me/148ilxnm');
  assert.equal(result.beacons[1].body.event_type, 'line_click');
  assert.equal(result.beacons[1].body.source, 'flyer_general_v1');
});

test('電話CTAクリックを送る', () => {
  const result = browser('https://aoki-tosou.net/');
  result.click('tel:0975940076');
  assert.equal(result.beacons[1].body.event_type, 'phone_click');
});

test('フォーム導線へ流入情報を引き継ぐ', () => {
  const result = browser('https://aoki-tosou.net/?from=meishi&utm_campaign=spring');
  const link = result.click('https://aokitosou-miniapp.web.app/index.html');
  assert.equal(result.beacons[1].body.event_type, 'form_link_click');
  assert.match(link.href, /from=meishi/);
  assert.match(link.href, /utm_campaign=spring/);
});

test('サイト内ページ遷移でも最初の流入元を保持する', () => {
  const first = browser('https://aoki-tosou.net/?utm_source=google&utm_medium=organic');
  const second = browser('https://aoki-tosou.net/about.html', 'https://aoki-tosou.net/', first.storage);
  assert.equal(second.beacons[0].body.source, 'google / organic');
  assert.match(second.beacons[0].body.landing_page, /utm_source=google/);
});
