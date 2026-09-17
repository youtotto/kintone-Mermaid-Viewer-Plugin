'use strict';

/**
 * source/config.html + source/config.js を jsdom 上で読み込み、設定画面の読み込み／保存を検証するヘルパー。
 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const CONFIG_HTML = path.resolve(__dirname, '../../source/config.html');
const CONFIG_JS = path.resolve(__dirname, '../../source/config.js');

function defaultFields() {
  return {
    顧客名: { type: 'SINGLE_LINE_TEXT', code: '顧客名', label: '顧客名' },
    Mermaidコード: { type: 'MULTI_LINE_TEXT', code: 'Mermaidコード', label: 'Mermaidコード' },
    構成図: { type: 'MULTI_LINE_TEXT', code: '構成図', label: 'システム構成図' },
    備考: { type: 'MULTI_LINE_TEXT', code: '備考', label: '備考' },
    明細: { type: 'SUBTABLE', code: '明細', label: '明細', fields: { 品名: { type: 'SINGLE_LINE_TEXT', code: '品名', label: '品名' } } }
  };
}

function defaultLayout() {
  return [
    { type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: '顧客名' }, { type: 'SPACER', elementId: 'top_space' }] },
    { type: 'GROUP', code: 'グループ', layout: [
      { type: 'ROW', fields: [{ type: 'SPACER', elementId: 'group_space' }] },
      { type: 'GROUP', code: 'ネスト', layout: [{ type: 'ROW', fields: [{ type: 'SPACER', elementId: 'nested_space' }] }] }
    ] },
    { type: 'SUBTABLE', code: '明細', fields: [{ type: 'SINGLE_LINE_TEXT', code: '品名' }, { type: 'SPACER', elementId: 'should_not_appear' }] },
    { type: 'ROW', fields: [{ type: 'SPACER' }] }
  ];
}

async function loadConfigScreen({ config = {}, fields = defaultFields(), layout = defaultLayout() } = {}) {
  const html = fs.readFileSync(CONFIG_HTML, 'utf8');
  const js = fs.readFileSync(CONFIG_JS, 'utf8');

  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://example.cybozu.com/k/admin/app/1/plugin/config',
    virtualConsole
  });
  const { window } = dom;

  let saved = null;
  const alerts = [];

  window.kintone = {
    $PLUGIN_ID: 'mock-plugin',
    app: {
      getId: () => 1,
      getFormFields: async () => JSON.parse(JSON.stringify(fields)),
      getFormLayout: async () => JSON.parse(JSON.stringify(layout))
    },
    plugin: { app: {
      getConfig: () => JSON.parse(JSON.stringify(config)),
      setConfig: (conf, cb) => { saved = conf; if (cb) cb(); }
    } }
  };
  window.alert = (msg) => { alerts.push(String(msg)); };

  window.eval(js);

  // init は非同期。行が描画されるまで待つ
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (window.document.querySelectorAll('#mappingBody tr').length > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }

  const doc = window.document;
  return {
    window, document: doc, alerts,
    rows: () => Array.from(doc.querySelectorAll('#mappingBody tr')),
    fieldSelect: (i) => doc.querySelectorAll('#mappingBody tr')[i].querySelector('.js-field'),
    spaceSelect: (i) => doc.querySelectorAll('#mappingBody tr')[i].querySelector('.js-space'),
    optionValues: (sel) => Array.from(sel.options).map(o => o.value),
    selectedText: (sel) => sel.selectedOptions[0]?.textContent || '',
    height: () => doc.getElementById('height').value,
    padding: () => doc.getElementById('padding').value,
    async save() {
      doc.getElementById('saveBtn').click();
      await new Promise((r) => setTimeout(r, 30));
      return { saved, mappings: saved ? JSON.parse(saved.mappings) : null, alerts: alerts.slice() };
    },
    addRow() { doc.getElementById('addRowBtn').click(); },
    change(sel, value) { sel.value = value; sel.dispatchEvent(new window.Event('change', { bubbles: true })); }
  };
}

module.exports = { loadConfigScreen, defaultFields, defaultLayout };
