// 人设设置组件（v2：人设来源/人设库/自定义）的 UI 测试。
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';

import {
  DEFAULT_PERSONA_CONFIG,
  PERSONA_LIBRARY_NAME_MAX_LENGTH,
  personaBlock,
} from '../src/channels/shared/persona.mjs';
import { PersonaEditor } from '../plugin-src/client/persona-settings.js';
import {
  IM_LOCALE_NAMESPACE,
  en,
  ru,
  setImTranslator,
} from '../plugin-src/client/i18n.js';
import { PERSONA_I18N } from '../plugin-src/client/persona-i18n.js';

const { act, create } = TestRenderer;

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.children?.map(textOf).join('') ?? '';
}

async function flush(times = 30) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function button(root, label) {
  const found = root.findAllByType('button').find((node) => textOf(node) === label);
  assert.ok(found, `missing button: ${label}`);
  return found;
}

function entry(root) {
  return root.findAllByType('button')
    .find((node) => typeof node.props.className === 'string'
      && node.props.className.includes('dim-personaEntry'));
}

function dialog(root) {
  return root.findAllByProps({ role: 'dialog' })[0];
}

function radio(root, value) {
  return root.findAllByType('input')
    .find((node) => node.props.type === 'radio' && node.props.value === value);
}

function fieldInput(root, suffix) {
  return root.findAllByType('input')
    .find((node) => typeof node.props.id === 'string' && node.props.id.endsWith(`-${suffix}`));
}

function fieldTextarea(root, suffix) {
  return root.findAllByType('textarea')
    .find((node) => typeof node.props.id === 'string' && node.props.id.endsWith(`-${suffix}`));
}

function previewTextarea(root) {
  return root.findAllByType('textarea').find((node) => node.props.readOnly === true
    && String(node.props.className ?? '').includes('dim-personaPreview'));
}

async function mount(t, props = {}) {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(PersonaEditor, {
      persona: DEFAULT_PERSONA_CONFIG,
      onSave: async () => {},
      ...props,
    }));
    await flush();
  });
  t.after(() => renderer.unmount());
  return renderer;
}

async function open(root) {
  await act(async () => { entry(root).props.onClick(); await flush(); });
  await act(async () => { await flush(); });
}

async function click(root, label) {
  await act(async () => { button(root, label).props.onClick(); await flush(); });
}

async function edit(node, value) {
  await act(async () => { node.props.onChange({ target: { value } }); await flush(); });
}

/** 人设管理 RPC 的测试替身：list/get/import/rename/remove 全内存实现。 */
function mockLibraryRpc() {
  const entries = [{
    id: 'dafeiyu', name: '大肥鱼', description: '傲娇的胖鱼', source: 'builtin', readonly: true,
  }];
  const texts = { dafeiyu: '# 人设：大肥鱼\n你是大肥鱼。' };
  const calls = [];
  const rpcCall = async (endpoint, payload = {}) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'persona.library.list') {
      return { ok: true, value: { entries: entries.map((item) => ({ ...item })) } };
    }
    if (endpoint === 'persona.library.get') {
      const found = entries.find((item) => item.id === payload.id);
      if (!found) return { ok: false, error: { code: 'bad-request', message: '人设不存在。' } };
      return { ok: true, value: { entry: { ...found, text: texts[found.id] ?? '' } } };
    }
    if (endpoint === 'persona.library.import') {
      if (!payload.name || !payload.text) {
        return { ok: false, error: { code: 'bad-request', message: '人设正文不能为空。' } };
      }
      const item = { id: 'p_imported', name: payload.name, description: '导入', source: 'imported', readonly: false };
      entries.push(item);
      texts[item.id] = payload.text;
      return { ok: true, value: { entry: { ...item, text: payload.text } } };
    }
    if (endpoint === 'persona.library.rename') {
      const found = entries.find((item) => item.id === payload.id);
      if (!found) return { ok: false, error: { code: 'bad-request', message: '人设不存在。' } };
      found.name = payload.name;
      return { ok: true, value: { entry: { ...found, text: texts[found.id] ?? '' } } };
    }
    if (endpoint === 'persona.library.remove') {
      const index = entries.findIndex((item) => item.id === payload.id);
      if (index >= 0) entries.splice(index, 1);
      return { ok: true, value: { removed: true } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  return { rpcCall, calls, entries };
}

test('默认「不使用」：入口显示未启用，保存 v2 配置', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const saved = [];
  const { rpcCall } = mockLibraryRpc();
  const renderer = await mount(t, { rpcCall, onSave: async (value) => { saved.push(value); } });
  const root = renderer.root;
  assert.equal(textOf(entry(root)).includes('Persona'), true);
  assert.equal(textOf(entry(root)).includes('Not enabled'), true);
  await open(root);
  assert.ok(dialog(root));
  // 英文界面：弹窗里除预览外不应出现中文。
  const panelText = textOf(dialog(root)).replace(previewTextarea(root)?.props.value ?? '', '');
  assert.doesNotMatch(panelText, /[\p{Script=Han}]/u);
  assert.equal(radio(root, 'off').props.checked, true);
  await click(root, 'Save');
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], DEFAULT_PERSONA_CONFIG);
  assert.equal(dialog(root), undefined);
});

test('自定义来源：填写字段后保存 v2 inline 配置并实时预览', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const saved = [];
  const { rpcCall } = mockLibraryRpc();
  const renderer = await mount(t, { rpcCall, onSave: async (value) => { saved.push(value); } });
  const root = renderer.root;
  await open(root);
  await act(async () => { radio(root, 'inline').props.onChange(); await flush(); });
  await edit(fieldInput(root, 'name'), '  大肥鱼  ');
  await edit(fieldTextarea(root, 'tone'), '傲娇');
  await edit(fieldTextarea(root, 'instructions'), '不要编造事实。');
  assert.equal(fieldInput(root, 'name').props.maxLength, 40);
  assert.equal(
    previewTextarea(root).props.value,
    personaBlock({ enabled: true, name: '大肥鱼', tone: '傲娇', instructions: '不要编造事实。' }),
  );
  await click(root, 'Save');
  assert.deepEqual(saved[0], {
    enabled: true, source: 'inline', personaId: '', name: '大肥鱼', tone: '傲娇', instructions: '不要编造事实。',
  });
});

test('人设库来源：加载列表、选择条目、注入预览与保存', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const saved = [];
  const { rpcCall, calls } = mockLibraryRpc();
  const renderer = await mount(t, { rpcCall, onSave: async (value) => { saved.push(value); } });
  const root = renderer.root;
  await open(root);
  await act(async () => { radio(root, 'library').props.onChange(); await flush(); });
  assert.equal(calls.some((call) => call.endpoint === 'persona.library.list'), true);
  const select = root.findAllByType('select')[0];
  assert.ok(select);
  await act(async () => { select.props.onChange({ target: { value: 'dafeiyu' } }); await flush(); });
  assert.equal(calls.some((call) => call.endpoint === 'persona.library.get' && call.payload.id === 'dafeiyu'), true);
  assert.equal(textOf(root).includes('傲娇的胖鱼'), true);
  // 查看全文后展示完整正文。
  await click(root, 'View full text');
  await act(async () => { await flush(); });
  assert.equal(textOf(dialog(root)).includes('收起全文') || textOf(dialog(root)).includes('Hide full text'), true);
  const fullText = root.findAllByType('textarea').find((node) => node.props['aria-label'] === 'Full persona text');
  assert.ok(fullText);
  assert.equal(fullText.props.value, '# 人设：大肥鱼\n你是大肥鱼。');
  await click(root, 'Save');
  assert.deepEqual(saved[0], {
    enabled: true, source: 'library', personaId: 'dafeiyu', name: '', tone: '', instructions: '',
  });
});

test('导入/重命名/删除人设库条目，并自动选中导入项', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { rpcCall, calls } = mockLibraryRpc();
  const renderer = await mount(t, { rpcCall });
  const root = renderer.root;
  await open(root);
  await act(async () => { radio(root, 'library').props.onChange(); await flush(); });
  await click(root, 'Import persona');
  await edit(root.findAllByType('input').find((node) => node.props.id === 'dim-persona-import-name'), '我的助手');
  await edit(root.findAllByType('textarea').find((node) => node.props.id === 'dim-persona-import-text'), '我的正文');
  await click(root, 'Import');
  const importedCall = calls.find((call) => call.endpoint === 'persona.library.import');
  assert.deepEqual(importedCall.payload, { name: '我的助手', text: '我的正文' });
  // 导入后自动选中导入项，并显示其正文。
  await act(async () => { await flush(); });
  assert.equal(root.findAllByType('select')[0].props.value, 'p_imported');

  await click(root, 'Rename');
  const nameInput = root.findAllByType('input').find((node) => node.props['aria-label'] === 'New name');
  assert.equal(nameInput.props.maxLength, PERSONA_LIBRARY_NAME_MAX_LENGTH);
  await edit(nameInput, '改名后');
  await click(root, 'Save name');
  assert.equal(calls.some((call) => call.endpoint === 'persona.library.rename'
    && call.payload.id === 'p_imported' && call.payload.name === '改名后'), true);

  await click(root, 'Delete');
  await click(root, 'Delete this persona');
  assert.equal(calls.some((call) => call.endpoint === 'persona.library.remove'
    && call.payload.id === 'p_imported'), true);
});

test('内置与 config 条目只读；保存失败保留草稿并展示本地化错误', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { rpcCall } = mockLibraryRpc();
  const renderer = await mount(t, {
    rpcCall,
    persona: { enabled: true, source: 'library', personaId: 'dafeiyu', name: '', tone: '', instructions: '' },
    onSave: async () => { throw new Error('无法读取或保存人设设置，请稍后重试。'); },
  });
  const root = renderer.root;
  await open(root);
  await act(async () => { await flush(); });
  const panel = textOf(dialog(root));
  assert.equal(panel.includes('Bundled persona; it cannot be modified.'), true);
  await click(root, 'Save');
  assert.ok(dialog(root));
  assert.equal(
    textOf(root.findByProps({ role: 'alert' })),
    PERSONA_I18N.en['无法读取或保存人设设置，请稍后重试。'],
  );
  // 入口状态标签来自已保存快照。
  assert.equal(textOf(entry(root)).includes('Enabled'), true);
});

test('人设词条已并入 DSH 客户端中英俄词典，覆盖 v2 UI', () => {
  assert.equal(IM_LOCALE_NAMESPACE, 'dsh-im-persona');
  const keys = Object.keys(PERSONA_I18N.zh);
  assert.ok(keys.length >= 100, `词条数偏少: ${keys.length}`);
  for (const key of keys) {
    // 少数中文源串与既有通用词条同键，由 DSH 词典后展开的通用译文覆盖。
    for (const [language, dictionary] of [['en', en], ['ru', ru]]) {
      assert.equal(Object.hasOwn(dictionary, key), true, `${language} 词条未并入: ${key}`);
      assert.equal(typeof dictionary[key], 'string');
      assert.doesNotMatch(dictionary[key], /[\u4e00-\u9fff]/u, `${language} 词条残留中文: ${key}`);
    }
  }
  for (const key of ['人设库', '导入人设', '查看全文', '重命名', '删除']) {
    assert.equal(Object.hasOwn(PERSONA_I18N.en, key), true);
  }
});
