(() => {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
  const PANZOOM_URL = 'https://unpkg.com/panzoom@9.4.3/dist/panzoom.min.js';

  const safeParse = (s, fallback) => {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  };

  const loadScriptOnce = (() => {
    const loaded = new Map();
    return (url) => new Promise((resolve, reject) => {
      if (loaded.get(url) === 'ok') return resolve();
      if (loaded.get(url) === 'loading') {
        const t = setInterval(() => {
          if (loaded.get(url) === 'ok') { clearInterval(t); resolve(); }
        }, 50);
        return;
      }
      loaded.set(url, 'loading');
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => { loaded.set(url, 'ok'); resolve(); };
      s.onerror = (e) => { loaded.delete(url); reject(e); };
      document.head.appendChild(s);
    });
  })();

  const initMermaidOnce = (() => {
    let initialized = false;
    return () => {
      if (initialized) return;
      if (!window.mermaid) return;
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'default',
      });
      initialized = true;
    };
  })();

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

  const attachWheelZoom = (viewport, instance, opts = {}) => {
    const step = opts.step ?? 0.12;
    const minZoom = opts.minZoom ?? 0.5;
    const maxZoom = opts.maxZoom ?? 8;

    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();

      const dir = Math.sign(e.deltaY);
      const factor = (dir > 0) ? (1 - step) : (1 + step);

      const rect = viewport.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      let currentScale = 1;
      try {
        const t = (typeof instance.getTransform === 'function') ? instance.getTransform() : null;
        if (t && typeof t.scale === 'number') currentScale = t.scale;
      } catch (_) { }

      let nextScale = currentScale * factor;
      nextScale = Math.min(maxZoom, Math.max(minZoom, nextScale));

      if (typeof instance.zoomAbs === 'function') {
        instance.zoomAbs(px, py, nextScale);
      } else if (typeof instance.zoom === 'function') {
        const rel = nextScale / currentScale;
        instance.zoom(rel);
      }
    }, { passive: false });
  };

  const renderMermaid = async (canvasEl, mermaidText) => {
    canvasEl.innerHTML = '';

    if (!mermaidText) {
      canvasEl.innerHTML = `<div style="color:#667085;font-size:13px;padding:10px;">Mermaidコードが未入力です。</div>`;
      return;
    }

    const id = `mermaid_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
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
  };

  const ensureStyle = () => {
    const styleId = 'nr-mermaid-style';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .nr-mermaid-wrap { border: 1px solid #e3e7ee; border-radius: 8px; padding: 10px; background: #fff; margin-bottom: 14px; }
      .nr-mermaid-toolbar { display:flex; gap:10px; align-items:center; margin-bottom:10px; }
      .nr-btn { padding:6px 10px; border:1px solid #c7cdd6; background:#f6f8fb; border-radius:6px; cursor:pointer; }
      .nr-btn:hover { background:#eef2f7; }
      .nr-hint { color:#667085; font-size:12px; }
      .nr-mermaid-viewport { width:100%; border: 1px dashed #d6dbe3; border-radius: 8px; overflow:hidden; position:relative; background:#fafbfc; }
      .nr-mermaid-canvas { position:absolute; left:0; top:0; width:100%; height:100%; }
      .nr-mermaid-canvas svg { width:100%; height:100%; display:block; }

      .nr-mermaid-overlay { position:fixed; inset:0; background:rgba(15,23,42,.55); display:none; z-index:999999; }
      .nr-mermaid-overlay.is-open { display:block; }
      .nr-mermaid-overlay__header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:#fff; border-bottom:1px solid #e3e7ee; }
      .nr-mermaid-overlay__title { font-weight:700; }
      .nr-mermaid-overlay__actions { display:flex; gap:10px; }
      .nr-mermaid-overlay__body { position:absolute; top:56px; left:0; right:0; bottom:0; padding:14px; }
      .nr-mermaid-viewport--fs { height: calc(100vh - 56px - 28px); border-style:solid; }
    `;
    document.head.appendChild(style);
  };

  const buildUIIntoSpace = (spaceEl, heightPx, titleText) => {
    ensureStyle();
    spaceEl.innerHTML = `
      <div class="nr-mermaid-wrap">
        <div class="nr-mermaid-toolbar">
          <button type="button" class="nr-btn" data-action="fullscreen">全画面</button>
          <span class="nr-hint">${titleText}</span>
        </div>
        <div class="nr-mermaid-viewport" style="height:${heightPx}px;">
          <div class="nr-mermaid-canvas"></div>
        </div>
      </div>

      <div class="nr-mermaid-overlay" aria-hidden="true">
        <div class="nr-mermaid-overlay__header">
          <div class="nr-mermaid-overlay__title">Mermaid 図（全画面）</div>
          <div class="nr-mermaid-overlay__actions">
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

    const viewport = spaceEl.querySelector('.nr-mermaid-viewport');
    const canvas = spaceEl.querySelector('.nr-mermaid-canvas');
    const fullBtn = spaceEl.querySelector('[data-action="fullscreen"]');

    const overlay = spaceEl.querySelector('.nr-mermaid-overlay');
    const fsViewport = overlay.querySelector('.nr-mermaid-viewport');
    const fsCanvas = overlay.querySelector('.nr-mermaid-canvas');
    const fsCloseBtn = overlay.querySelector('[data-action="close_fs"]');

    return { viewport, canvas, fullBtn, overlay, fsViewport, fsCanvas, fsCloseBtn };
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

  const enablePanzoom = (ui, padding) => {
    if (!window.panzoom) return;
    const svg = ui.canvas.querySelector('svg');
    if (!svg) return;

    const tryNormalize = (tries = 0) => {
      const ok = normalizeViewBoxToContent(svg, padding);
      if (ok) return;
      if (tries >= 6) return;
      requestAnimationFrame(() => tryNormalize(tries + 1));
    };
    tryNormalize(0);

    const instance = window.panzoom(svg, { minZoom: 0.5, maxZoom: 8 });
    attachWheelZoom(ui.viewport, instance, { step: 0.12, minZoom: 0.5, maxZoom: 8 });
  };

  // ===== 詳細画面 =====
  kintone.events.on('app.record.detail.show', async (event) => {
    const conf = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
    const mappings = safeParse(conf.mappings || '[]', []);
    const height = parseInt(conf.height || '720', 10);
    const padding = parseInt(conf.padding || '30', 10);

    if (!Array.isArray(mappings) || mappings.length === 0) return event;

    await loadScriptOnce(MERMAID_URL);
    await loadScriptOnce(PANZOOM_URL);
    initMermaidOnce();

    // それぞれのマッピングで、指定スペースに描画
    for (const m of mappings) {
      const fieldCode = m?.fieldCode;
      const spaceId = m?.spaceId;
      if (!fieldCode || !spaceId) continue;

      const spaceEl = kintone.app.record.getSpaceElement(spaceId);
      if (!spaceEl) {
        console.warn(`[Mermaid] Space not found: ${spaceId}`);
        continue;
      }

      const mermaidText = (typeof event.record?.[fieldCode]?.value === 'string')
        ? event.record[fieldCode].value.trim()
        : '';

      const title = `field: ${fieldCode} / space: ${spaceId}`;
      const ui = buildUIIntoSpace(spaceEl, height, title);

      // 通常
      await renderMermaid(ui.canvas, mermaidText);
      enablePanzoom({ viewport: ui.viewport, canvas: ui.canvas }, padding);

      // 全画面
      ui.fullBtn.addEventListener('click', async () => {
        openOverlay(ui);
        await renderMermaid(ui.fsCanvas, mermaidText);
        enablePanzoom({ viewport: ui.fsViewport, canvas: ui.fsCanvas }, padding);
      });
      ui.fsCloseBtn.addEventListener('click', () => closeOverlay(ui));

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && ui.overlay.classList.contains('is-open')) closeOverlay(ui);
      });
      ui.overlay.addEventListener('click', (e) => {
        if (e.target === ui.overlay) closeOverlay(ui);
      });
    }

    return event;
  });

})();
