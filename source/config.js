(() => {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  const $mappingBody = document.getElementById('mappingBody');
  const $addRowBtn = document.getElementById('addRowBtn');
  const $height = document.getElementById('height');
  const $padding = document.getElementById('padding');
  const $saveBtn = document.getElementById('saveBtn');
  const $cancelBtn = document.getElementById('cancelBtn');

  const safeParse = (s, fallback) => {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  };

  const escapeHtml = (s) => String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  // --- MULTI_LINE_TEXTのみ ---
  const fetchMultiLineTextFields = async () => {
    const resp = await kintone.api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', {
      app: kintone.app.getId()
    });

    const props = resp.properties || {};
    return Object.keys(props)
      .map((code) => ({ code, ...props[code] }))
      .filter((p) => p.type === 'MULTI_LINE_TEXT')
      .map((p) => ({ code: p.code, label: p.label || p.code }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ja'));
  };

  // --- layoutからSPACE(elementId)候補 ---
  const fetchSpacesFromLayout = async () => {
    const resp = await kintone.api(kintone.api.url('/k/v1/app/form/layout', true), 'GET', {
      app: kintone.app.getId()
    });

    const rows = resp.layout || [];
    const spaces = [];

    rows.forEach((row) => {
      (row.fields || []).forEach((f) => {
        const t = f.type;
        if (t === 'SPACER' || t === 'SPACE') {
          const elementId = f.elementId || '';
          if (elementId) spaces.push({ elementId, label: elementId });
        }
      });
    });

    const uniq = new Map();
    spaces.forEach((s) => uniq.set(s.elementId, s));
    return [...uniq.values()].sort((a, b) => a.elementId.localeCompare(b.elementId));
  };

  // ===== 重複チェック（fieldCode+spaceId） =====
  const findDuplicatePairs = (mappings) => {
    // key: `${fieldCode}__${spaceId}` => indexes[]
    const map = new Map();
    mappings.forEach((m, idx) => {
      const key = `${m.fieldCode}__${m.spaceId}`;
      const arr = map.get(key) || [];
      arr.push(idx);
      map.set(key, arr);
    });

    const dups = [];
    for (const [key, idxs] of map.entries()) {
      if (idxs.length >= 2) {
        const [fieldCode, spaceId] = key.split('__');
        dups.push({ fieldCode, spaceId, idxs });
      }
    }
    return dups;
  };

  const buildRow = ({ fieldCode = '', spaceId = '' }, fields, spaces) => {
    const tr = document.createElement('tr');

    const tdField = document.createElement('td');
    const selField = document.createElement('select');
    selField.className = 'nrc-select js-field';
    selField.innerHTML = fields.length
      ? fields.map(f => `<option value="${escapeHtml(f.code)}">${escapeHtml(f.label)} (${escapeHtml(f.code)})</option>`).join('')
      : `<option value="">（複数行テキストがありません）</option>`;
    if (fieldCode) selField.value = fieldCode;
    tdField.appendChild(selField);

    const tdSpace = document.createElement('td');
    const selSpace = document.createElement('select');
    selSpace.className = 'nrc-select js-space';
    selSpace.innerHTML = spaces.length
      ? spaces.map(s => `<option value="${escapeHtml(s.elementId)}">${escapeHtml(s.label)}</option>`).join('')
      : `<option value="">（スペース要素がありません）</option>`;
    if (spaceId) selSpace.value = spaceId;
    tdSpace.appendChild(selSpace);

    const tdAct = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nrc-btn';
    btn.textContent = '削除';
    btn.addEventListener('click', () => {
      tr.remove();
      if ($mappingBody.querySelectorAll('tr').length === 0) {
        addRow({}, fields, spaces); // 0行事故防止
      }
    });
    tdAct.appendChild(btn);

    tr.appendChild(tdField);
    tr.appendChild(tdSpace);
    tr.appendChild(tdAct);

    return tr;
  };

  const addRow = (init, fields, spaces) => {
    $mappingBody.appendChild(buildRow(init, fields, spaces));
  };

  const readMappings = () => {
    const trs = [...$mappingBody.querySelectorAll('tr')];
    return trs.map((tr) => {
      const fieldCode = tr.querySelector('.js-field')?.value || '';
      const spaceId = tr.querySelector('.js-space')?.value || '';
      return { fieldCode, spaceId };
    }).filter(m => m.fieldCode && m.spaceId);
  };

  const goBackToPluginList = () => {
    location.href = `/k/admin/app/${kintone.app.getId()}/plugin/?message=CONFIG_SAVED#/`;
  };

  // ===== スペース重複チェック =====
  const findDuplicateSpaces = (mappings) => {
    const map = new Map(); // spaceId => indexes[]

    mappings.forEach((m, idx) => {
      const arr = map.get(m.spaceId) || [];
      arr.push(idx);
      map.set(m.spaceId, arr);
    });

    const dups = [];
    for (const [spaceId, idxs] of map.entries()) {
      if (idxs.length >= 2) {
        dups.push({ spaceId, idxs });
      }
    }
    return dups;
  };


  // --- init ---
  (async () => {
    const conf = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
    const savedMappings = safeParse(conf.mappings || '[]', []);

    $height.value = conf.height || '500';
    $padding.value = conf.padding || '30';

    let fields = [];
    let spaces = [];
    try {
      [fields, spaces] = await Promise.all([
        fetchMultiLineTextFields(),
        fetchSpacesFromLayout()
      ]);
    } catch (e) {
      console.error(e);
      alert('フィールド/レイアウト情報の取得に失敗しました。権限をご確認ください。');
      return;
    }

    if (Array.isArray(savedMappings) && savedMappings.length) {
      savedMappings.forEach(m => addRow(m, fields, spaces));
    } else {
      addRow({}, fields, spaces);
    }

    $addRowBtn.addEventListener('click', () => addRow({}, fields, spaces));

    $cancelBtn.addEventListener('click', () => {
      history.back();
    });

    $saveBtn.addEventListener('click', () => {
      const mappings = readMappings();
      if (!mappings.length) {
        alert('少なくとも1件、フィールドとスペースの組み合わせ（マッピング）を設定してください。');
        return;
      }

      // ① フィールド × スペース完全一致の重複チェック
      const pairDups = findDuplicatePairs(mappings);
      if (pairDups.length) {
        const msg = pairDups.map(d =>
          `・${d.fieldCode} × ${d.spaceId}（行: ${d.idxs.map(i => i + 1).join(', ')}）`
        ).join('\n');
        alert(
          `同じフィールドと同じスペースの組み合わせが重複しています。\n\n${msg}`
        );
        return;
      }

      // ② スペース単位の重複チェック ★追加
      const spaceDups = findDuplicateSpaces(mappings);
      if (spaceDups.length) {
        const msg = spaceDups.map(d =>
          `・スペース「${d.spaceId}」が複数行で使用されています（行: ${d.idxs.map(i => i + 1).join(', ')}）`
        ).join('\n');
        alert(
          `同じスペースに複数のフィールドを割り当てることはできません。\n\n${msg}\n\n` +
          `1スペースにつき、1つの Mermaid フィールドのみ指定してください。`
        );
        return;
      }

      const heightNum = parseInt($height.value || '500', 10);
      const paddingNum = parseInt($padding.value || '30', 10);

      const configObj = {
        mappings: JSON.stringify(mappings),
        height: String(Number.isFinite(heightNum) ? heightNum : 500),
        padding: String(Number.isFinite(paddingNum) ? paddingNum : 30),
      };

      kintone.plugin.app.setConfig(configObj, () => {
        goBackToPluginList();
      });
    });
  })();

})();
