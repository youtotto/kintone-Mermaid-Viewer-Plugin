(() => {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
  const PANZOOM_URL = 'https://unpkg.com/panzoom@9.4.3/dist/panzoom.min.js';

  // 外部スクリプトの読み込み待ち上限（これを超えたら失敗扱いにして待機を打ち切る）
  const SCRIPT_LOAD_TIMEOUT_MS = 20000;

  const ZOOM = { step: 0.12, min: 0.5, max: 8 };

  const safeParse = (s, fallback) => {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  };

  const escapeHtml = (s) => String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  // ===== 外部スクリプト読み込み =====
  // URL ごとに Promise をキャッシュする。失敗・タイムアウト時は reject してキャッシュを捨て、
  // 待機側に setInterval / setTimeout が残らないようにする。
  const loadScriptOnce = (() => {
    const cache = new Map();
    return (url) => {
      if (cache.has(url)) return cache.get(url);

      const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let settled = false;
        let timer = null;

        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (err) {
            cache.delete(url);
            script.remove();
            reject(err);
          } else {
            resolve();
          }
        };

        timer = setTimeout(() => finish(new Error(`script load timeout: ${url}`)), SCRIPT_LOAD_TIMEOUT_MS);
        script.src = url;
        script.async = true;
        script.onload = () => finish(null);
        script.onerror = () => finish(new Error(`script load failed: ${url}`));
        document.head.appendChild(script);
      });

      cache.set(url, promise);
      return promise;
    };
  })();

  const initMermaidOnce = (() => {
    let initialized = false;
    return () => {
      if (initialized) return;
      if (!window.mermaid) return;
      window.mermaid.initialize({
        startOnLoad: false,
        // Viewer 用途のため、レコードに保存された Mermaid コード由来の
        // HTML / click コールバック等の JavaScript 実行は許可しない
        securityLevel: 'strict',
        theme: 'default',
      });
      initialized = true;
    };
  })();

  // ===== Mermaid エラーの要約 =====
  const describeMermaidError = (err) => {
    const message = String(err?.str ?? err?.message ?? '');
    const hash = err?.hash || null;

    let line = null;
    const m = message.match(/on line (\d+)/i);
    if (m) line = Number(m[1]);
    else if (hash && Number.isFinite(Number(hash.line))) line = Number(hash.line) + 1;

    let reason = '';
    if (hash && hash.token) {
      reason = `「${String(hash.token)}」の付近に問題があります`;
    } else {
      const first = message.split('\n').map(s => s.trim()).find(Boolean) || '';
      if (first && !/^Parse error/i.test(first)) {
        reason = first.length > 80 ? `${first.slice(0, 80)}…` : first;
      }
    }

    return { line, reason };
  };

  const buildRenderErrorHtml = (err) => {
    const { line, reason } = describeMermaidError(err);
    const detail = [
      line ? `${line}行目付近` : '',
      reason
    ].filter(Boolean).join('：');
    return `
      <div class="nr-mermaid-message nr-mermaid-message--error" role="alert">
        <div>Mermaid図を表示できませんでした。構文を確認してください。</div>
        ${detail ? `<div class="nr-mermaid-message__detail">${escapeHtml(detail)}</div>` : ''}
      </div>
    `;
  };

  const buildInfoHtml = (text) =>
    `<div class="nr-mermaid-message">${escapeHtml(text)}</div>`;

  const buildLibraryErrorHtml = () =>
    `<div class="nr-mermaid-message nr-mermaid-message--error" role="alert">図の表示に必要なライブラリを読み込めませんでした。</div>`;

  // Mermaid が描画用に body 直下へ作る一時要素（失敗時に残る #d{id} と、その中の #{id}）を除去する。
  // 正常描画した SVG は canvas 内にあり、この id では参照しないので対象にならない。
  const cleanupMermaidTempDom = (id) => {
    [`d${id}`, id].forEach((elId) => {
      const el = document.getElementById(elId);
      if (el && !el.closest('.nr-mermaid-canvas')) el.remove();
    });
  };

  // ===== 描画 =====
  // 戻り値: { ok: true, empty?: true } または { ok: false, error }
  const renderMermaid = async (canvasEl, mermaidText) => {
    canvasEl.innerHTML = '';

    if (!mermaidText) {
      canvasEl.innerHTML = buildInfoHtml('Mermaidコードが未入力です。');
      return { ok: true, empty: true };
    }

    const id = `nrmermaid_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    try {
      // 先に構文だけ検証する（parse は DOM を生成しない）
      if (typeof window.mermaid.parse === 'function') {
        await window.mermaid.parse(mermaidText);
      }

      const { svg, bindFunctions } = await window.mermaid.render(id, mermaidText);
      canvasEl.innerHTML = svg;
      if (typeof bindFunctions === 'function') bindFunctions(canvasEl);

      const svgEl = canvasEl.querySelector('svg');
      if (svgEl) {
        svgEl.style.maxWidth = 'none';
        svgEl.style.width = '100%';
        svgEl.style.height = '100%';
        svgEl.style.touchAction = 'none';
        svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      }
      return { ok: true };
    } catch (err) {
      cleanupMermaidTempDom(id);
      console.error('[Mermaid Viewer] Mermaid の描画に失敗しました。', err);
      canvasEl.innerHTML = buildRenderErrorHtml(err);
      return { ok: false, error: err };
    }
  };

  // ===== 表示領域（viewBox）の正規化と全体表示 =====
  const normalizeViewBoxToContent = (svg, padding) => {
    let bb;
    try { bb = svg.getBBox(); } catch (e) { return false; }
    if (!bb || !bb.width || !bb.height) return false;
    const x = bb.x - padding;
    const y = bb.y - padding;
    const w = bb.width + padding * 2;
    const h = bb.height + padding * 2;
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    return true;
  };

  const getScale = (instance) => {
    try {
      const t = (instance && typeof instance.getTransform === 'function') ? instance.getTransform() : null;
      if (t && typeof t.scale === 'number') return t.scale;
    } catch (_) { }
    return 1;
  };

  /**
   * ビューア状態: { viewport, canvas, svg, instance, padding }
   * 「全体表示」= viewBox を内容に合わせ、pan/zoom を初期状態（倍率1・移動なし）に戻す。
   * 初回描画・全体表示ボタン・全画面表示のすべてでこの関数を使う。
   */
  const fitToView = (state) => {
    if (!state || !state.svg) return;

    const tryNormalize = (tries = 0) => {
      const ok = normalizeViewBoxToContent(state.svg, state.padding);
      if (ok) return;
      if (tries >= 6) return;
      requestAnimationFrame(() => tryNormalize(tries + 1));
    };
    tryNormalize(0);

    const inst = state.instance;
    if (!inst) return;
    if (typeof inst.moveTo === 'function') inst.moveTo(0, 0);
    if (typeof inst.zoomAbs === 'function') inst.zoomAbs(0, 0, 1);
  };

  const zoomBy = (state, factor, clientX, clientY) => {
    const inst = state && state.instance;
    if (!inst) return;

    const rect = state.viewport.getBoundingClientRect();
    const px = (typeof clientX === 'number') ? clientX - rect.left : rect.width / 2;
    const py = (typeof clientY === 'number') ? clientY - rect.top : rect.height / 2;

    const current = getScale(inst);
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, current * factor));

    if (typeof inst.zoomAbs === 'function') {
      inst.zoomAbs(px, py, next);
    } else if (typeof inst.zoom === 'function') {
      inst.zoom(next / current);
    }
  };

  // ホイールズームは独自制御に統一する（panzoom 標準のホイール処理は beforeWheel で無効化）
  const attachWheelZoom = (state) => {
    state.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = Math.sign(e.deltaY);
      if (dir === 0) return;
      const factor = (dir > 0) ? (1 - ZOOM.step) : (1 + ZOOM.step);
      zoomBy(state, factor, e.clientX, e.clientY);
    }, { passive: false });
  };

  const createViewer = (viewport, canvas, padding) => {
    const svg = canvas.querySelector('svg');
    if (!svg) return null;

    const state = { viewport, canvas, svg, instance: null, padding };

    if (window.panzoom) {
      state.instance = window.panzoom(svg, {
        minZoom: ZOOM.min,
        maxZoom: ZOOM.max,
        // 標準のホイールズームを無効化（独自ハンドラと二重に効くのを防ぐ）
        beforeWheel: () => true,
        // ダブルクリックズームも無効化
        zoomDoubleClickSpeed: 1,
      });
      attachWheelZoom(state);
    }

    fitToView(state);
    return state;
  };

  // ===== スタイル =====
  const ensureStyle = () => {
    const styleId = 'nr-mermaid-style';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .nr-mermaid-wrap { border: 1px solid #e3e7ee; border-radius: 8px; padding: 10px; background: #fff; margin-bottom: 14px; }
      .nr-mermaid-toolbar { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap: wrap; }
      .nr-btn { padding:6px 10px; border:1px solid #c7cdd6; background:#f6f8fb; border-radius:6px; cursor:pointer; font-size:13px; line-height:1.2; }
      .nr-btn:hover { background:#eef2f7; }
      .nr-btn:focus-visible { outline: 2px solid #1f6feb; outline-offset: 1px; }
      .nr-btn[disabled] { opacity:.5; cursor:not-allowed; }
      .nr-btn--icon { min-width: 32px; text-align:center; }
      .nr-hint { color:#667085; font-size:12px; margin-left:auto; }
      .nr-mermaid-viewport { width:100%; border: 1px dashed #d6dbe3; border-radius: 8px; overflow:hidden; position:relative; background:#fafbfc; }
      .nr-mermaid-canvas { position:absolute; left:0; top:0; width:100%; height:100%; }
      .nr-mermaid-canvas svg { width:100%; height:100%; display:block; }
      .nr-mermaid-message { color:#667085; font-size:13px; padding:10px; line-height:1.6; }
      .nr-mermaid-message--error { color:#b3261e; }
      .nr-mermaid-message__detail { color:#667085; font-size:12px; margin-top:4px; }

      .nr-mermaid-overlay { position:fixed; inset:0; background:rgba(15,23,42,.55); display:none; z-index:999999; }
      .nr-mermaid-overlay.is-open { display:block; }
      .nr-mermaid-overlay__header { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 16px; background:#fff; border-bottom:1px solid #e3e7ee; }
      .nr-mermaid-overlay__title { font-weight:700; }
      .nr-mermaid-overlay__actions { display:flex; gap:8px; align-items:center; }
      .nr-mermaid-overlay__body { position:absolute; top:56px; left:0; right:0; bottom:0; padding:14px; }
      .nr-mermaid-viewport--fs { height: calc(100vh - 56px - 28px); border-style:solid; }
    `;
    document.head.appendChild(style);
  };

  const toolbarButtonsHtml = () => `
    <button type="button" class="nr-btn" data-action="fit" title="図全体が見える状態に戻す">全体表示</button>
    <button type="button" class="nr-btn nr-btn--icon" data-action="zoom_out" aria-label="縮小" title="縮小">−</button>
    <button type="button" class="nr-btn nr-btn--icon" data-action="zoom_in" aria-label="拡大" title="拡大">＋</button>
  `;

  const buildUIIntoSpace = (spaceEl, heightPx, titleText) => {
    ensureStyle();
    spaceEl.innerHTML = `
      <div class="nr-mermaid-wrap">
        <div class="nr-mermaid-toolbar">
          ${toolbarButtonsHtml()}
          <button type="button" class="nr-btn" data-action="fullscreen">全画面</button>
          <span class="nr-hint">${escapeHtml(titleText)}</span>
        </div>
        <div class="nr-mermaid-viewport" style="height:${heightPx}px;">
          <div class="nr-mermaid-canvas">${buildInfoHtml('読み込み中…')}</div>
        </div>
      </div>

      <div class="nr-mermaid-overlay" aria-hidden="true">
        <div class="nr-mermaid-overlay__header">
          <div class="nr-mermaid-overlay__title">Mermaid 図（全画面）</div>
          <div class="nr-mermaid-overlay__actions">
            ${toolbarButtonsHtml()}
            <button type="button" class="nr-btn" data-action="close_fs">閉じる</button>
          </div>
        </div>
        <div class="nr-mermaid-overlay__body">
          <div class="nr-mermaid-viewport nr-mermaid-viewport--fs">
            <div class="nr-mermaid-canvas"></div>
          </div>
        </div>
      </div>
    `;

    const wrap = spaceEl.querySelector('.nr-mermaid-wrap');
    const overlay = spaceEl.querySelector('.nr-mermaid-overlay');

    return {
      wrap,
      toolbar: wrap.querySelector('.nr-mermaid-toolbar'),
      viewport: wrap.querySelector('.nr-mermaid-viewport'),
      canvas: wrap.querySelector('.nr-mermaid-canvas'),
      overlay,
      fsActions: overlay.querySelector('.nr-mermaid-overlay__actions'),
      fsViewport: overlay.querySelector('.nr-mermaid-viewport'),
      fsCanvas: overlay.querySelector('.nr-mermaid-canvas'),
    };
  };

  // zoom: 全体表示／＋／−（panzoom が使えるときだけ有効）, fullscreen: 全画面（図が描画できていれば有効）
  const setToolbarEnabled = (container, { zoom = false, fullscreen = false } = {}) => {
    container.querySelectorAll('button[data-action]').forEach((b) => {
      const action = b.dataset.action;
      if (action === 'close_fs') return;
      b.disabled = (action === 'fullscreen') ? !fullscreen : !zoom;
    });
  };

  const openOverlay = (ui) => {
    ui.overlay.classList.add('is-open');
    ui.overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };
  const closeOverlay = (ui) => {
    ui.overlay.classList.remove('is-open');
    ui.overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  // Esc で開いている全画面を閉じる（ページに1回だけ登録）
  const ensureEscapeHandler = (() => {
    let bound = false;
    return () => {
      if (bound) return;
      bound = true;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.nr-mermaid-overlay.is-open').forEach((overlay) => {
          overlay.classList.remove('is-open');
          overlay.setAttribute('aria-hidden', 'true');
        });
        document.body.style.overflow = '';
      });
    };
  })();

  // ツールバー（通常／全画面）のボタンにビューア状態を結び付ける
  const bindViewerButtons = (container, getState) => {
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      const state = getState();
      switch (btn.dataset.action) {
        case 'fit': fitToView(state); break;
        case 'zoom_in': zoomBy(state, 1 + ZOOM.step); break;
        case 'zoom_out': zoomBy(state, 1 - ZOOM.step); break;
        default: break;
      }
    });
  };

  // 1 マッピング分のビューアを組み立てる。失敗してもここで完結させ、呼び出し側のループを止めない。
  const setupMapping = async (target, padding) => {
    const { ui, mermaidText } = target;
    let state = null;
    let fsState = null;

    const result = await renderMermaid(ui.canvas, mermaidText);
    const rendered = result.ok && !result.empty;
    if (rendered) {
      state = createViewer(ui.viewport, ui.canvas, padding);
    }
    setToolbarEnabled(ui.toolbar, { zoom: Boolean(state && state.instance), fullscreen: rendered });

    bindViewerButtons(ui.toolbar, () => state);
    bindViewerButtons(ui.fsActions, () => fsState);

    ui.toolbar.querySelector('[data-action="fullscreen"]').addEventListener('click', async () => {
      openOverlay(ui);
      try {
        const r = await renderMermaid(ui.fsCanvas, mermaidText);
        fsState = (r.ok && !r.empty) ? createViewer(ui.fsViewport, ui.fsCanvas, padding) : null;
      } catch (err) {
        console.error('[Mermaid Viewer] 全画面表示の描画に失敗しました。', err);
        ui.fsCanvas.innerHTML = buildRenderErrorHtml(err);
        fsState = null;
      }
      setToolbarEnabled(ui.fsActions, { zoom: Boolean(fsState && fsState.instance) });
    });
    ui.fsActions.querySelector('[data-action="close_fs"]').addEventListener('click', () => closeOverlay(ui));
    ui.overlay.addEventListener('click', (e) => {
      if (e.target === ui.overlay) closeOverlay(ui);
    });
    ensureEscapeHandler();
  };

  // ===== 詳細画面 =====
  kintone.events.on('app.record.detail.show', async (event) => {
    const conf = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
    const mappings = safeParse(conf.mappings || '[]', []);
    const height = parseInt(conf.height || '500', 10);
    const padding = parseInt(conf.padding || '30', 10);

    if (!Array.isArray(mappings) || mappings.length === 0) return event;

    // 1) 先に各スペースへ枠を作る（読み込み失敗時もここへメッセージを出せる）
    const targets = [];
    for (const m of mappings) {
      const fieldCode = m?.fieldCode;
      const spaceId = m?.spaceId;
      if (!fieldCode || !spaceId) continue;

      const spaceEl = kintone.app.record.getSpaceElement(spaceId);
      if (!spaceEl) {
        console.warn(`[Mermaid Viewer] スペースが見つかりません: ${spaceId}`);
        continue;
      }

      const field = event.record?.[fieldCode];
      const mermaidText = (typeof field?.value === 'string') ? field.value.trim() : '';

      const title = `field: ${fieldCode} / space: ${spaceId}`;
      const ui = buildUIIntoSpace(spaceEl, Number.isFinite(height) ? height : 500, title);
      setToolbarEnabled(ui.toolbar, {});

      if (!field) {
        console.warn(`[Mermaid Viewer] フィールドが見つかりません: ${fieldCode}`);
        ui.canvas.innerHTML = buildInfoHtml('Mermaidコードのフィールドが見つかりません。プラグインの設定を確認してください。');
        continue;
      }

      targets.push({ ui, mermaidText, fieldCode, spaceId });
    }

    if (targets.length === 0) return event;

    // 2) ライブラリ読み込み（失敗・タイムアウトは利用者向けメッセージにして終了）
    const [mermaidLoad, panzoomLoad] = await Promise.allSettled([
      loadScriptOnce(MERMAID_URL),
      loadScriptOnce(PANZOOM_URL),
    ]);

    if (mermaidLoad.status === 'rejected' || !window.mermaid) {
      console.error('[Mermaid Viewer] Mermaid の読み込みに失敗しました。', mermaidLoad.reason);
      targets.forEach(({ ui }) => {
        ui.canvas.innerHTML = buildLibraryErrorHtml();
        setToolbarEnabled(ui.toolbar, {});
      });
      return event;
    }
    if (panzoomLoad.status === 'rejected') {
      // 図の表示は続ける（拡大・移動だけ利用不可）
      console.error('[Mermaid Viewer] panzoom の読み込みに失敗しました。拡大・移動は利用できません。', panzoomLoad.reason);
    }

    initMermaidOnce();

    // 3) マッピングごとに独立して描画（1件の失敗で後続を止めない）
    for (const target of targets) {
      try {
        await setupMapping(target, Number.isFinite(padding) ? padding : 30);
      } catch (err) {
        console.error('[Mermaid Viewer] 描画処理でエラーが発生しました。', { fieldCode: target.fieldCode, spaceId: target.spaceId, err });
        target.ui.canvas.innerHTML = buildRenderErrorHtml(err);
        setToolbarEnabled(target.ui.toolbar, {});
      }
    }

    return event;
  });

})();
