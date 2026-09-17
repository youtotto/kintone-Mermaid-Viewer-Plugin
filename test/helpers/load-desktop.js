'use strict';

/**
 * source/desktop.js を jsdom 上で読み込むヘルパー。
 * - kintone API をスタブ
 * - CDN スクリプトの読み込みを横取りし、mermaid / panzoom のスタブを注入（失敗・無応答も再現可能）
 * - 長いタイムアウト（スクリプト読み込み待ち）はテスト用に短縮
 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const DESKTOP_PATH = path.resolve(__dirname, '../../source/desktop.js');
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
const PANZOOM_URL = 'https://unpkg.com/panzoom@9.4.3/dist/panzoom.min.js';

function makeParseError() {
  const e = new Error("Parse error on line 2:\n...ERROR\n-----^\nExpecting 'NODE_STRING', got 'ERROR'");
  e.hash = { line: 1, token: 'ERROR', expected: ["'NODE_STRING'"] };
  return e;
}

/** mermaid v10 の挙動を模したスタブ */
function makeMermaidStub(window, log) {
  const doc = window.document;
  return {
    initialize(cfg) { log.initialize.push(cfg); },
    async parse(text) {
      log.parses.push(text);
      if (/ERROR/.test(text)) throw makeParseError();
      return true;
    },
    async render(id, text) {
      log.renders.push({ id, text });
      if (/RENDERBOMB/.test(text)) {
        // 実際の mermaid v10 が失敗時に body 直下へ残す一時要素（爆弾 SVG）を再現
        const d = doc.createElement('div');
        d.id = `d${id}`;
        d.innerHTML = '<svg><text>Syntax error in text</text></svg>';
        doc.body.appendChild(d);
        const e = new Error('Parse error on line 3:\nRENDERBOMB');
        e.hash = { line: 2, token: 'RENDERBOMB' };
        throw e;
      }
      if (/ERROR/.test(text)) throw makeParseError();
      if (/RENDERFAIL/.test(text)) throw new Error('No diagram type detected matching given configuration for text');
      const safe = text.replace(/[^A-Za-z0-9_ -]/g, '');
      return {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" data-src="${safe}"><rect width="200" height="100"></rect></svg>`
      };
    }
  };
}

/** panzoom v9 の挙動を模したスタブ（標準ホイールズームの有無を beforeWheel で再現） */
function makePanzoomStub(window, log) {
  return function panzoom(el, opts = {}) {
    const t = { x: 0, y: 0, scale: 1 };
    const inst = {
      zoomCalls: 0,
      getTransform: () => ({ ...t }),
      zoomAbs(x, y, s) { inst.zoomCalls++; t.scale = s; },
      zoom(f) { inst.zoomCalls++; t.scale *= f; },
      moveTo(x, y) { t.x = x; t.y = y; },
      dispose() { }
    };
    // 実際の panzoom は owner（SVG の親）に wheel を登録し、beforeWheel が true を返すと無視する
    const owner = el.parentElement || el;
    owner.addEventListener('wheel', (e) => {
      if (typeof opts.beforeWheel === 'function' && opts.beforeWheel(e)) return;
      inst.zoomAbs(0, 0, t.scale * 1.25);
    });
    log.panzoomInstances.push({ el, opts, inst });
    return inst;
  };
}

/**
 * @param {object} o
 * @param {object} o.config  kintone.plugin.app.getConfig の戻り値
 * @param {string[]} o.spaces  ページに置くスペース要素の elementId
 * @param {string[]} o.failScripts  onerror を発火させる URL
 * @param {string[]} o.hangScripts  onload/onerror を一切発火させない URL（タイムアウト経路）
 */
function loadDesktop({ config = {}, spaces = ['s1'], failScripts = [], hangScripts = [] } = {}) {
  const log = { initialize: [], parses: [], renders: [], panzoomInstances: [], scriptsAppended: [], errors: [], warns: [] };

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args) => log.errors.push(args));
  virtualConsole.on('warn', (...args) => log.warns.push(args));

  const html = `<!doctype html><html><body>${spaces.map(id => `<div data-space="${id}"></div>`).join('')}</body></html>`;
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.cybozu.com/k/1/show',
    virtualConsole
  });
  const { window } = dom;
  const document = window.document;

  // jsdom の SVG には getBBox が無いためスタブ
  window.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: 200, height: 100 }; };

  // スクリプト読み込みタイムアウト（20秒）をテスト用に短縮
  const origSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...args) => origSetTimeout(fn, (ms >= 10000) ? 30 : ms, ...args);

  // <script src> の追加を横取りしてスタブを注入
  const origAppend = document.head.appendChild.bind(document.head);
  document.head.appendChild = (el) => {
    if (el.tagName === 'SCRIPT' && el.src) {
      const src = el.src;
      log.scriptsAppended.push(src);
      origSetTimeout(() => {
        if (hangScripts.includes(src)) return;
        if (failScripts.includes(src)) { el.onerror && el.onerror(new window.Event('error')); return; }
        if (src === MERMAID_URL) window.mermaid = makeMermaidStub(window, log);
        if (src === PANZOOM_URL) window.panzoom = makePanzoomStub(window, log);
        el.onload && el.onload(new window.Event('load'));
      }, 0);
      return el;
    }
    return origAppend(el);
  };

  const handlers = {};
  window.kintone = {
    $PLUGIN_ID: 'mock-plugin',
    plugin: { app: { getConfig: () => JSON.parse(JSON.stringify(config)) } },
    events: { on: (ev, fn) => { [].concat(ev).forEach((e) => { handlers[e] = fn; }); } },
    app: { record: { getSpaceElement: (id) => document.querySelector(`[data-space="${id}"]`) } }
  };

  window.eval(fs.readFileSync(DESKTOP_PATH, 'utf8'));

  const flush = (ms = 80) => new Promise((r) => origSetTimeout(r, ms));

  return {
    window, document, log,
    MERMAID_URL, PANZOOM_URL,
    /** 詳細画面表示イベントを発火し、ハンドラ完了後に少し待つ */
    async show(record) {
      const fn = handlers['app.record.detail.show'];
      if (!fn) throw new Error('handler not registered');
      const result = await fn({ record });
      await flush();
      return result;
    },
    flush,
    space: (id) => document.querySelector(`[data-space="${id}"]`),
    canvas: (id) => document.querySelector(`[data-space="${id}"] .nr-mermaid-wrap .nr-mermaid-canvas`),
    viewport: (id) => document.querySelector(`[data-space="${id}"] .nr-mermaid-wrap .nr-mermaid-viewport`),
    toolbar: (id) => document.querySelector(`[data-space="${id}"] .nr-mermaid-toolbar`),
    overlay: (id) => document.querySelector(`[data-space="${id}"] .nr-mermaid-overlay`),
    button: (id, action) => document.querySelector(`[data-space="${id}"] .nr-mermaid-toolbar [data-action="${action}"]`),
    fsButton: (id, action) => document.querySelector(`[data-space="${id}"] .nr-mermaid-overlay [data-action="${action}"]`),
    /** そのスペースの panzoom インスタンス（通常表示側 = 最初に作られたもの） */
    instanceFor(id) {
      const svg = this.canvas(id)?.querySelector('svg');
      return log.panzoomInstances.find(p => p.el === svg)?.inst || null;
    },
    wheel(el, deltaY = -100) {
      const ev = new window.WheelEvent('wheel', { deltaY, clientX: 50, clientY: 50, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev;
    }
  };
}

const mappings = (...pairs) => JSON.stringify(pairs.map(([fieldCode, spaceId]) => ({ fieldCode, spaceId })));
const rec = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { type: 'MULTI_LINE_TEXT', value: v }]));

module.exports = { loadDesktop, mappings, rec, MERMAID_URL, PANZOOM_URL };
