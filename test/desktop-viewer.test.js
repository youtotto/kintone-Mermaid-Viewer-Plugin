'use strict';

// P1: ホイールズームの二重適用、全体表示（Fit）、＋／−、全画面

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadDesktop, mappings, rec } = require('./helpers/load-desktop');

const OK = 'graph LR\n  A --> B';
const config = { mappings: mappings(['f1', 's1']), height: '400', padding: '20' };

async function ready() {
  const app = loadDesktop({ config });
  await app.show(rec({ f1: OK }));
  const inst = app.instanceFor('s1');
  assert.ok(inst, 'panzoom インスタンスが作られている');
  return { app, inst };
}

describe('ホイールズーム', () => {
  test('panzoom は標準ホイールズーム無効（beforeWheel が true）・ダブルクリックズーム無効で初期化される', async () => {
    const { app } = await ready();
    const { opts } = app.log.panzoomInstances[0];
    assert.equal(typeof opts.beforeWheel, 'function');
    assert.equal(opts.beforeWheel({}), true);
    assert.equal(opts.zoomDoubleClickSpeed, 1);
    assert.equal(opts.minZoom, 0.5);
    assert.equal(opts.maxZoom, 8);
  });

  test('1回の wheel で zoom は1回だけ呼ばれ、倍率は 1.12 になる', async () => {
    const { app, inst } = await ready();
    const before = inst.zoomCalls;
    const svg = app.canvas('s1').querySelector('svg');
    const ev = app.wheel(svg, -100);
    assert.equal(inst.zoomCalls - before, 1, 'zoom 呼び出しが1回');
    assert.ok(Math.abs(inst.getTransform().scale - 1.12) < 1e-9);
    assert.equal(ev.defaultPrevented, true);
  });

  test('下方向 wheel は縮小（0.88倍）', async () => {
    const { app, inst } = await ready();
    app.wheel(app.viewport('s1'), 100);
    assert.ok(Math.abs(inst.getTransform().scale - 0.88) < 1e-9);
  });

  test('倍率は 0.5〜8 に丸められる', async () => {
    const { app, inst } = await ready();
    for (let i = 0; i < 40; i++) app.wheel(app.viewport('s1'), -100);
    assert.equal(inst.getTransform().scale, 8);
    for (let i = 0; i < 80; i++) app.wheel(app.viewport('s1'), 100);
    assert.equal(inst.getTransform().scale, 0.5);
  });
});

describe('全体表示（Fit）と ＋／−', () => {
  test('初回描画時に全体表示（倍率1・移動なし・viewBox は内容に合わせる）', async () => {
    const { app, inst } = await ready();
    const t = inst.getTransform();
    assert.deepEqual([t.x, t.y, t.scale], [0, 0, 1]);
    const svg = app.canvas('s1').querySelector('svg');
    // getBBox スタブ {0,0,200,100} + padding 20
    assert.equal(svg.getAttribute('viewBox'), '-20 -20 240 140');
    assert.equal(svg.getAttribute('preserveAspectRatio'), 'xMidYMid meet');
  });

  test('pan / zoom 後に「全体表示」で初期状態へ戻る', async () => {
    const { app, inst } = await ready();
    inst.zoomAbs(10, 10, 3.5);
    inst.moveTo(-500, 320);
    assert.equal(inst.getTransform().scale, 3.5);

    app.button('s1', 'fit').click();
    const t = inst.getTransform();
    assert.deepEqual([t.x, t.y, t.scale], [0, 0, 1]);
  });

  test('＋ で 1.12 倍、− で元に近づく', async () => {
    const { app, inst } = await ready();
    app.button('s1', 'zoom_in').click();
    assert.ok(Math.abs(inst.getTransform().scale - 1.12) < 1e-9);
    app.button('s1', 'zoom_out').click();
    assert.ok(Math.abs(inst.getTransform().scale - 1.12 * 0.88) < 1e-9);
  });

  test('ツールバーに 全体表示 / − / ＋ / 全画面 があり有効', async () => {
    const { app } = await ready();
    const labels = Array.from(app.toolbar('s1').querySelectorAll('button')).map(b => b.textContent.trim());
    assert.deepEqual(labels, ['全体表示', '−', '＋', '全画面']);
    Array.from(app.toolbar('s1').querySelectorAll('button')).forEach(b => assert.equal(b.disabled, false));
  });
});

describe('全画面', () => {
  test('全画面を開くと別キャンバスに描画され、全体表示から始まる。閉じるで戻る', async () => {
    const { app } = await ready();
    app.button('s1', 'fullscreen').click();
    await app.flush();

    const overlay = app.overlay('s1');
    assert.ok(overlay.classList.contains('is-open'));
    assert.equal(overlay.getAttribute('aria-hidden'), 'false');
    assert.equal(app.document.body.style.overflow, 'hidden');

    const fsSvg = overlay.querySelector('.nr-mermaid-canvas svg');
    assert.ok(fsSvg, '全画面側に svg');
    const fsInst = app.log.panzoomInstances.find(p => p.el === fsSvg)?.inst;
    assert.ok(fsInst);
    assert.deepEqual(Object.values(fsInst.getTransform()), [0, 0, 1]);

    // 全画面側の全体表示ボタンは全画面側のインスタンスに効く
    fsInst.zoomAbs(0, 0, 2);
    app.fsButton('s1', 'fit').click();
    assert.equal(fsInst.getTransform().scale, 1);

    app.fsButton('s1', 'close_fs').click();
    assert.equal(overlay.classList.contains('is-open'), false);
    assert.equal(app.document.body.style.overflow, '');
  });

  test('Esc で閉じる（document に1回だけ登録）', async () => {
    const app = loadDesktop({ config: { ...config, mappings: mappings(['f1', 's1'], ['f2', 's2']) }, spaces: ['s1', 's2'] });
    await app.show(rec({ f1: OK, f2: OK }));
    app.button('s2', 'fullscreen').click();
    await app.flush();
    assert.ok(app.overlay('s2').classList.contains('is-open'));
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(app.overlay('s2').classList.contains('is-open'), false);
    assert.equal(app.document.body.style.overflow, '');
  });

  test('背景クリックで閉じる', async () => {
    const { app } = await ready();
    app.button('s1', 'fullscreen').click();
    await app.flush();
    app.overlay('s1').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    assert.equal(app.overlay('s1').classList.contains('is-open'), false);
  });
});

describe('単一 / 複数マッピングの回帰', () => {
  test('単一マッピング: svg・ツールバー・高さ指定', async () => {
    const { app } = await ready();
    assert.ok(app.canvas('s1').querySelector('svg'));
    assert.equal(app.viewport('s1').style.height, '400px');
  });

  test('複数マッピング: それぞれ独立した panzoom インスタンス', async () => {
    const app = loadDesktop({ config: { ...config, mappings: mappings(['f1', 's1'], ['f2', 's2']) }, spaces: ['s1', 's2'] });
    await app.show(rec({ f1: OK, f2: OK }));
    const i1 = app.instanceFor('s1');
    const i2 = app.instanceFor('s2');
    assert.ok(i1 && i2 && i1 !== i2);
    app.button('s1', 'zoom_in').click();
    assert.ok(i1.getTransform().scale > 1);
    assert.equal(i2.getTransform().scale, 1);
  });

  test('height / padding 未設定時の既定は 500 / 30', async () => {
    const app = loadDesktop({ config: { mappings: mappings(['f1', 's1']) } });
    await app.show(rec({ f1: OK }));
    assert.equal(app.viewport('s1').style.height, '500px');
    assert.equal(app.canvas('s1').querySelector('svg').getAttribute('viewBox'), '-30 -30 260 160');
  });
});
