'use strict';

// 設定画面: GROUP 内スペースの候補化、削除済みフィールド／スペースの保持、保存・重複制御

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfigScreen } = require('./helpers/load-config');

const savedConfig = {
  mappings: JSON.stringify([
    { fieldCode: 'Mermaidコード', spaceId: 'top_space' },
    { fieldCode: '削除済みフィールド', spaceId: 'group_space' },
    { fieldCode: '構成図', spaceId: '削除済みスペース' }
  ]),
  height: '640',
  padding: '25'
};

describe('GROUP 内スペース', () => {
  test('最上位・GROUP 内・ネストした GROUP 内のスペースが候補に出る', async () => {
    const ui = await loadConfigScreen({ config: {} });
    const values = ui.optionValues(ui.spaceSelect(0));
    assert.ok(values.includes('top_space'));
    assert.ok(values.includes('group_space'));
    assert.ok(values.includes('nested_space'));
  });

  test('SUBTABLE 内の要素と elementId の無いスペースは候補に出ない', async () => {
    const ui = await loadConfigScreen({ config: {} });
    const values = ui.optionValues(ui.spaceSelect(0));
    assert.ok(!values.includes('should_not_appear'));
    assert.ok(!values.includes(''));
    assert.equal(values.length, 3);
  });

  test('フィールド候補は複数行テキストのみ（サブテーブル内・1行テキストは出ない）', async () => {
    const ui = await loadConfigScreen({ config: {} });
    const values = ui.optionValues(ui.fieldSelect(0));
    assert.deepEqual(values.sort(), ['Mermaidコード', '備考', '構成図'].sort());
  });
});

describe('削除済みフィールド／スペースの保持', () => {
  test('読み込み時に「現在使用できないフィールド／スペース」として表示され、値が残る', async () => {
    const ui = await loadConfigScreen({ config: savedConfig });
    assert.equal(ui.rows().length, 3);

    assert.equal(ui.fieldSelect(1).value, '削除済みフィールド');
    assert.match(ui.selectedText(ui.fieldSelect(1)), /現在使用できないフィールド/);
    assert.equal(ui.spaceSelect(1).value, 'group_space');

    assert.equal(ui.spaceSelect(2).value, '削除済みスペース');
    assert.match(ui.selectedText(ui.spaceSelect(2)), /現在使用できないスペース/);
    assert.equal(ui.fieldSelect(2).value, '構成図');
  });

  test('正常な行には一時オプションが付かない', async () => {
    const ui = await loadConfigScreen({ config: savedConfig });
    const texts = Array.from(ui.fieldSelect(0).options).map(o => o.textContent);
    assert.ok(!texts.some(t => t.includes('現在使用できない')));
  });

  test('何も変更せず保存 → field / space / height / padding / mapping 数が不変', async () => {
    const ui = await loadConfigScreen({ config: savedConfig });
    const { saved, mappings, alerts } = await ui.save();
    assert.deepEqual(alerts, []);
    assert.ok(saved);
    assert.deepEqual(mappings, JSON.parse(savedConfig.mappings));
    assert.equal(saved.height, '640');
    assert.equal(saved.padding, '25');
  });

  test('height / padding は読み込み時に保存値が表示される', async () => {
    const ui = await loadConfigScreen({ config: savedConfig });
    assert.equal(ui.height(), '640');
    assert.equal(ui.padding(), '25');
  });
});

describe('保存・重複制御（既存機能）', () => {
  test('通常保存: 選択したマッピングと数値が保存される', async () => {
    const ui = await loadConfigScreen({ config: {} });
    ui.change(ui.fieldSelect(0), '構成図');
    ui.change(ui.spaceSelect(0), 'group_space');
    ui.document.getElementById('height').value = '700';
    ui.document.getElementById('padding').value = '10';
    const { saved, mappings } = await ui.save();
    assert.deepEqual(mappings, [{ fieldCode: '構成図', spaceId: 'group_space' }]);
    assert.equal(saved.height, '700');
    assert.equal(saved.padding, '10');
  });

  test('同じスペースを2行で使うと alert で保存されない', async () => {
    const ui = await loadConfigScreen({ config: {} });
    ui.addRow();
    ui.change(ui.fieldSelect(0), 'Mermaidコード');
    ui.change(ui.spaceSelect(0), 'top_space');
    ui.change(ui.fieldSelect(1), '構成図');
    ui.change(ui.spaceSelect(1), 'top_space');
    const { saved, alerts } = await ui.save();
    assert.equal(saved, null);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /同じスペースに複数のフィールドを割り当てることはできません/);
  });

  test('同じフィールド×同じスペースの完全重複も alert', async () => {
    const ui = await loadConfigScreen({ config: {} });
    ui.addRow();
    ui.change(ui.fieldSelect(0), 'Mermaidコード');
    ui.change(ui.spaceSelect(0), 'top_space');
    ui.change(ui.fieldSelect(1), 'Mermaidコード');
    ui.change(ui.spaceSelect(1), 'top_space');
    const { saved, alerts } = await ui.save();
    assert.equal(saved, null);
    assert.match(alerts[0], /重複/);
  });

  test('同じフィールドを別スペースに割り当てるのは許可される', async () => {
    const ui = await loadConfigScreen({ config: {} });
    ui.addRow();
    ui.change(ui.fieldSelect(0), 'Mermaidコード');
    ui.change(ui.spaceSelect(0), 'top_space');
    ui.change(ui.fieldSelect(1), 'Mermaidコード');
    ui.change(ui.spaceSelect(1), 'nested_space');
    const { mappings, alerts } = await ui.save();
    assert.deepEqual(alerts, []);
    assert.equal(mappings.length, 2);
  });

  test('行を全部削除すると自動で1行残る（0行事故防止）', async () => {
    const ui = await loadConfigScreen({ config: {} });
    ui.rows()[0].querySelector('button').click();
    assert.equal(ui.rows().length, 1);
  });
});
