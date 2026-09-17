'use strict';

// CDN 読み込み失敗・タイムアウト時に無限待機せず、利用者向けエラーを表示する

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadDesktop, mappings, rec, MERMAID_URL, PANZOOM_URL } = require('./helpers/load-desktop');

const OK = 'graph LR\n  A --> B';
const config = { mappings: mappings(['f1', 's1'], ['f2', 's2']), height: '500', padding: '30' };
const record = () => rec({ f1: OK, f2: OK });

/** ハンドラが一定時間内に完了しなければ失敗（無限待機の検出） */
const withDeadline = (p, ms = 2000) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`handler did not settle within ${ms}ms`)), ms))
]);

describe('CDN 読み込み', () => {
  test('成功: 両ライブラリが読み込まれ描画される（スクリプトは各1回だけ追加）', async () => {
    const app = loadDesktop({ config, spaces: ['s1', 's2'] });
    await withDeadline(app.show(record()));
    assert.deepEqual(app.log.scriptsAppended.sort(), [MERMAID_URL, PANZOOM_URL].sort());
    assert.ok(app.canvas('s1').querySelector('svg'));
    assert.ok(app.canvas('s2').querySelector('svg'));
  });

  test('Mermaid 失敗（onerror）: 全マッピングにライブラリエラーを表示し、例外で止まらない', async () => {
    const app = loadDesktop({ config, spaces: ['s1', 's2'], failScripts: [MERMAID_URL] });
    const result = await withDeadline(app.show(record()));
    assert.ok(result, 'event が返る');
    ['s1', 's2'].forEach((id) => {
      assert.match(app.canvas(id).textContent, /図の表示に必要なライブラリを読み込めませんでした。/);
      assert.equal(app.button(id, 'fullscreen').disabled, true);
    });
    assert.ok(app.log.errors.some(a => String(a[0]).includes('Mermaid の読み込みに失敗')));
  });

  test('panzoom だけ失敗: 図は描画され、拡大・移動系は無効', async () => {
    const app = loadDesktop({ config, spaces: ['s1', 's2'], failScripts: [PANZOOM_URL] });
    await withDeadline(app.show(record()));
    assert.ok(app.canvas('s1').querySelector('svg'), '図は表示される');
    assert.equal(app.log.panzoomInstances.length, 0);
    assert.equal(app.button('s1', 'fit').disabled, true);
    assert.equal(app.button('s1', 'zoom_in').disabled, true);
    assert.equal(app.button('s1', 'fullscreen').disabled, false, '全画面は図が出ていれば使える');
    assert.ok(app.log.errors.some(a => String(a[0]).includes('panzoom の読み込みに失敗')));
  });

  test('Mermaid 無応答（タイムアウト）: 待機が打ち切られてエラー表示される', async () => {
    const app = loadDesktop({ config, spaces: ['s1', 's2'], hangScripts: [MERMAID_URL] });
    await withDeadline(app.show(record()));
    assert.match(app.canvas('s1').textContent, /ライブラリを読み込めませんでした/);
    assert.ok(app.log.errors.some(a => /timeout/.test(String(a[1]?.message ?? a[1]))));
  });

  test('両方無応答でも無限待機しない', async () => {
    const app = loadDesktop({ config, spaces: ['s1', 's2'], hangScripts: [MERMAID_URL, PANZOOM_URL] });
    await withDeadline(app.show(record()));
    assert.match(app.canvas('s2').textContent, /ライブラリを読み込めませんでした/);
  });

  test('失敗後はキャッシュが捨てられ、次回表示で再度読み込みを試みる', async () => {
    const app = loadDesktop({ config, spaces: ['s1', 's2'], failScripts: [MERMAID_URL] });
    await withDeadline(app.show(record()));
    const first = app.log.scriptsAppended.filter(u => u === MERMAID_URL).length;
    await withDeadline(app.show(record()));
    const second = app.log.scriptsAppended.filter(u => u === MERMAID_URL).length;
    assert.equal(first, 1);
    assert.equal(second, 2, '再試行される');
    // 成功した panzoom は再読み込みされない
    assert.equal(app.log.scriptsAppended.filter(u => u === PANZOOM_URL).length, 1);
  });

  test('読み込み中はプレースホルダを表示する', async () => {
    const app = loadDesktop({ config, spaces: ['s1', 's2'], hangScripts: [MERMAID_URL] });
    const p = app.show(record());
    // スクリプト追加直後（onload 前）
    await new Promise(r => setTimeout(r, 0));
    assert.match(app.canvas('s1').textContent, /読み込み中/);
    await withDeadline(p);
  });
});
