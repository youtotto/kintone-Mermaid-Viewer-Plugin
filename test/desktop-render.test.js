'use strict';

// P0-1: マッピング単位の独立描画、構文エラー表示、一時 DOM の cleanup、securityLevel

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadDesktop, mappings, rec } = require('./helpers/load-desktop');

const OK1 = 'graph LR\n  A --> B';
const OK2 = 'sequenceDiagram\n  A->>B: hi';
const OK3 = 'classDiagram\n  class X';
const BAD = 'graph TD\n  A -->\n  ERROR';

const baseConfig = { mappings: mappings(['f1', 's1'], ['f2', 's2'], ['f3', 's3']), height: '500', padding: '30' };

describe('複数マッピングの独立描画', () => {
  test('正常3件 → 3件すべて描画される', async () => {
    const app = loadDesktop({ config: baseConfig, spaces: ['s1', 's2', 's3'] });
    await app.show(rec({ f1: OK1, f2: OK2, f3: OK3 }));
    ['s1', 's2', 's3'].forEach((id) => {
      assert.ok(app.canvas(id).querySelector('svg'), `${id} に svg がある`);
    });
    assert.equal(app.log.renders.length, 3);
  });

  test('正常・エラー・正常 → 1件目と3件目は描画、2件目はエラー表示', async () => {
    const app = loadDesktop({ config: baseConfig, spaces: ['s1', 's2', 's3'] });
    await app.show(rec({ f1: OK1, f2: BAD, f3: OK3 }));

    assert.ok(app.canvas('s1').querySelector('svg'), '1件目 描画');
    assert.ok(app.canvas('s3').querySelector('svg'), '3件目 描画（2件目の失敗で止まらない）');

    const c2 = app.canvas('s2');
    assert.equal(c2.querySelector('svg'), null, '2件目 svg なし');
    assert.match(c2.textContent, /Mermaid図を表示できませんでした。構文を確認してください。/);
    assert.ok(c2.querySelector('[role="alert"]'), 'role=alert が付く');
  });

  test('先頭エラー・正常 → 2件目は描画される', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 's1'], ['f2', 's2']) }, spaces: ['s1', 's2'] });
    await app.show(rec({ f1: BAD, f2: OK2 }));
    assert.equal(app.canvas('s1').querySelector('svg'), null);
    assert.match(app.canvas('s1').textContent, /表示できませんでした/);
    assert.ok(app.canvas('s2').querySelector('svg'));
  });

  test('エラー後も detail.show ハンドラは event を返す（例外で全体停止しない）', async () => {
    const app = loadDesktop({ config: baseConfig, spaces: ['s1', 's2', 's3'] });
    const record = rec({ f1: BAD, f2: BAD, f3: BAD });
    const result = await app.show(record);
    assert.equal(result.record, record);
  });
});

describe('構文エラーの表示内容', () => {
  test('行番号と簡潔な理由が表示され、スタックトレースは表示されない', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 's1']) } });
    await app.show(rec({ f1: BAD }));
    const text = app.canvas('s1').textContent;
    assert.match(text, /2行目付近/);
    assert.match(text, /「ERROR」の付近に問題があります/);
    assert.doesNotMatch(text, /Expecting/, '開発者向けメッセージを出さない');
    assert.doesNotMatch(text, /at /, 'スタックトレースを出さない');
  });

  test('詳細は console.error に残る', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 's1']) } });
    await app.show(rec({ f1: BAD }));
    assert.ok(app.log.errors.some(args => String(args[0]).includes('描画に失敗')));
  });

  test('構文エラー以外の描画エラーも利用者向け文言で表示（メッセージ先頭を短く）', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 's1']) } });
    await app.show(rec({ f1: 'RENDERFAIL' }));
    const text = app.canvas('s1').textContent;
    assert.match(text, /表示できませんでした/);
    assert.match(text, /No diagram type detected/);
  });

  test('エラー時はツールバー（全体表示／±／全画面）が無効化される', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 's1']) } });
    await app.show(rec({ f1: BAD }));
    ['fit', 'zoom_in', 'zoom_out', 'fullscreen'].forEach((a) => {
      assert.equal(app.button('s1', a).disabled, true, `${a} disabled`);
    });
  });
});

describe('Mermaid 一時 DOM の cleanup', () => {
  test('render 失敗時に body 直下へ残る #d{id}（爆弾 SVG）が除去される', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 's1'], ['f2', 's2']) }, spaces: ['s1', 's2'] });
    await app.show(rec({ f1: 'RENDERBOMB', f2: OK2 }));
    const leftovers = Array.from(app.document.body.children).filter(el => /^d?nrmermaid_/.test(el.id));
    assert.deepEqual(leftovers.map(e => e.id), [], '一時要素が残らない');
    assert.equal(app.document.body.textContent.includes('Syntax error in text'), false, '爆弾 SVG の文言が残らない');
    assert.match(app.canvas('s1').textContent, /表示できませんでした/);
    assert.match(app.canvas('s1').textContent, /3行目付近/);
    assert.ok(app.canvas('s2').querySelector('svg'), '後続は描画される');
  });

  test('正常描画の SVG は cleanup で削除されない', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 's1'], ['f2', 's2']) }, spaces: ['s1', 's2'] });
    await app.show(rec({ f1: OK1, f2: 'RENDERBOMB' }));
    assert.ok(app.canvas('s1').querySelector('svg'));
  });

  test('parse が先に失敗した場合は render が呼ばれない（DOM を汚さない）', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 's1']) } });
    await app.show(rec({ f1: BAD }));
    assert.equal(app.log.parses.length, 1);
    assert.equal(app.log.renders.length, 0);
  });
});

describe('securityLevel', () => {
  test('mermaid.initialize は securityLevel: strict で1回だけ呼ばれる', async () => {
    const app = loadDesktop({ config: baseConfig, spaces: ['s1', 's2', 's3'] });
    await app.show(rec({ f1: OK1, f2: OK2, f3: OK3 }));
    assert.equal(app.log.initialize.length, 1);
    assert.equal(app.log.initialize[0].securityLevel, 'strict');
    assert.equal(app.log.initialize[0].startOnLoad, false);
  });

  test('ソース上に loose が残っていない', () => {
    const src = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../source/desktop.js'), 'utf8');
    assert.doesNotMatch(src, /securityLevel:\s*['"]loose['"]/);
  });
});

describe('空データ・フィールド不在・スペース不在', () => {
  test('Mermaid コード空欄 → 未入力メッセージ、ボタンは無効', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 's1']) } });
    await app.show(rec({ f1: '   ' }));
    assert.match(app.canvas('s1').textContent, /Mermaidコードが未入力です/);
    assert.equal(app.button('s1', 'fullscreen').disabled, true);
  });

  test('フィールドがレコードに無い → 設定確認メッセージ、他マッピングは描画', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['deleted', 's1'], ['f2', 's2']) }, spaces: ['s1', 's2'] });
    await app.show(rec({ f2: OK2 }));
    assert.match(app.canvas('s1').textContent, /フィールドが見つかりません/);
    assert.ok(app.canvas('s2').querySelector('svg'));
    assert.ok(app.log.warns.some(a => String(a[0]).includes('フィールドが見つかりません')));
  });

  test('スペースが無いマッピングはスキップし、他は描画（例外なし）', async () => {
    const app = loadDesktop({ config: { ...baseConfig, mappings: mappings(['f1', 'missing_space'], ['f2', 's2']) }, spaces: ['s2'] });
    await app.show(rec({ f1: OK1, f2: OK2 }));
    assert.ok(app.canvas('s2').querySelector('svg'));
    assert.ok(app.log.warns.some(a => String(a[0]).includes('スペースが見つかりません')));
  });

  test('マッピング未設定なら何もしない', async () => {
    const app = loadDesktop({ config: {} });
    await app.show(rec({ f1: OK1 }));
    assert.equal(app.space('s1').innerHTML, '');
    assert.equal(app.log.scriptsAppended.length, 0);
  });
});
