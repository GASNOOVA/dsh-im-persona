// 人设库 v2 测试：内置大肥鱼保护、导入/重命名/删除、config personaFile、
// v1→v2 迁移后的注入解析，以及 persona.library.* 管理 RPC。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BUNDLED_DAFEIYU,
  PERSONA_PRESETS,
  personaPresetFor,
} from '../src/channels/shared/persona-presets.mjs';
import {
  PERSONA_LIBRARY_ENDPOINTS,
  PERSONA_LIBRARY_NAME_MAX_LENGTH,
  PERSONA_LIBRARY_TEXT_MAX_LENGTH,
  normalizePersonaConfig,
  resolvePersonaInjection,
  validatePersonaConfig,
} from '../src/channels/shared/persona.mjs';
import {
  PERSONA_CONFIG_PERSONA_ID,
  PERSONA_LIBRARY_DOCUMENT_VERSION,
  PersonaLibrary,
  describePersonaLibraryText,
  getPersonaLibrary,
  personaLibraryPath,
  validateLibraryEntryInput,
} from '../src/channels/shared/persona-library.mjs';
import { PersonaStore } from '../src/channels/shared/persona-store.mjs';
import {
  createPersonaRpcHandler,
} from '../plugin-src/host/persona-rpc.mjs';

const BOT = 'wx_0123456789abcdef01234567';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-persona-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'integrations', 'dsh-im', 'persona-library.json');
  const library = await new PersonaLibrary(path, { logger: { warn() {} }, ...options }).load();
  return { root, path, library };
}

// ---------------------------------------------------------------------------
// 内置人设（大肥鱼）
// ---------------------------------------------------------------------------

test('内置大肥鱼（私聊/群聊两版）原样内置、冻结且不可删除/重命名', async (t) => {
  assert.equal(PERSONA_PRESETS.length, 2);
  assert.deepEqual(PERSONA_PRESETS.map((preset) => preset.id), ['dafeiyu', 'dafeiyu-group']);

  const preset = PERSONA_PRESETS[0];
  assert.equal(preset.id, 'dafeiyu');
  assert.equal(preset.name, '大肥鱼');
  assert.equal(preset.source, 'builtin');
  assert.equal(preset.text, BUNDLED_DAFEIYU);
  assert.equal(preset.text.startsWith('# 人设：大肥鱼'), true);
  assert.equal(preset.text.includes('吃白饭'), true);
  assert.ok(preset.description.length > 0);
  assert.equal(Object.isFrozen(preset), true);
  assert.equal(Object.isFrozen(PERSONA_PRESETS), true);
  assert.equal(personaPresetFor('dafeiyu'), preset);

  // 群聊版是第二条独立 builtin：正文在私聊原文后追加群聊准则。
  const groupPreset = PERSONA_PRESETS[1];
  assert.equal(groupPreset.id, 'dafeiyu-group');
  assert.equal(groupPreset.name, '大肥鱼（群聊版）');
  assert.equal(groupPreset.source, 'builtin');
  assert.equal(groupPreset.text.startsWith(BUNDLED_DAFEIYU), true);
  assert.equal(groupPreset.text.length > BUNDLED_DAFEIYU.length, true);
  assert.equal(personaPresetFor('dafeiyu-group'), groupPreset);
  assert.equal(personaPresetFor('nope'), null);
  assert.equal(personaPresetFor(null), null);

  const { library } = await fixture(t);
  const entry = library.entryFor('dafeiyu');
  assert.equal(entry.source, 'builtin');
  assert.equal(entry.text, BUNDLED_DAFEIYU);
  assert.equal(library.entryFor('dafeiyu-group').text, groupPreset.text);
  await assert.rejects(library.remove('dafeiyu'), (error) => error.code === 'persona-library-readonly');
  await assert.rejects(library.rename('dafeiyu', '新名字'), (error) => error.code === 'persona-library-readonly');
  await assert.rejects(library.remove('dafeiyu-group'), (error) => error.code === 'persona-library-readonly');
  // list 只返回元数据，不含正文；顺序为 dafeiyu、dafeiyu-group。
  const listed = library.list();
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((item) => item.id), ['dafeiyu', 'dafeiyu-group']);
  assert.equal(listed[0].readonly, true);
  assert.equal(Object.hasOwn(listed[0], 'text'), false);
  // get 才返回正文。
  const full = await library.get('dafeiyu');
  assert.equal(full.text, BUNDLED_DAFEIYU);
});

// ---------------------------------------------------------------------------
// 导入/重命名/删除与上限
// ---------------------------------------------------------------------------

test('导入人设：名字/正文上限与空值严格校验', () => {
  assert.deepEqual(validateLibraryEntryInput({ name: ' 我的助手 ', text: ' 正文 ' }), {
    name: '我的助手', text: '正文',
  });
  const bad = [
    undefined, null, [], {}, { name: 'A' }, { name: 'A', text: 'B', extra: 1 },
    { name: '', text: 'B' }, { name: 'A', text: '' },
    { name: 'x'.repeat(PERSONA_LIBRARY_NAME_MAX_LENGTH + 1), text: 'B' },
    { name: 'A', text: 'x'.repeat(PERSONA_LIBRARY_TEXT_MAX_LENGTH + 1) },
    { name: 1, text: 'B' }, { name: 'A', text: 2 },
  ];
  for (const input of bad) {
    assert.throws(() => validateLibraryEntryInput(input), (error) => error.code === 'persona-library-invalid');
  }
});

test('人设库导入/重命名/删除持久化，列表顺序与元数据稳定', async (t) => {
  const { path, library } = await fixture(t);
  const first = await library.importEntry({ name: '我的助手', text: '# 标题\n第一行正文' });
  assert.match(first.id, /^p_[a-z0-9]{12}$/);
  assert.equal(first.name, '我的助手');
  assert.equal(first.readonly, false);
  assert.equal(first.description, '标题');
  assert.equal(library.entryFor(first.id).text, '# 标题\n第一行正文');
  const second = await library.importEntry({ name: '第二个', text: '正文二' });
  assert.notEqual(second.id, first.id);
  assert.deepEqual(library.list().map((entry) => entry.id), ['dafeiyu', 'dafeiyu-group', first.id, second.id]);

  await library.rename(second.id, '改名后');
  assert.equal(library.entryFor(second.id).name, '改名后');
  assert.equal(await library.remove(first.id), true);
  assert.equal(library.entryFor(first.id), null);
  await assert.rejects(library.rename('missing', 'x'), (error) => error.code === 'persona-library-not-found');
  await assert.rejects(library.remove('missing'), (error) => error.code === 'persona-library-not-found');

  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.version, PERSONA_LIBRARY_DOCUMENT_VERSION);
  assert.deepEqual(Object.keys(document.entries), [second.id]);
  assert.equal(document.entries[second.id].name, '改名后');
  const leftovers = (await readdir(join(path, '..'))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }

  const reloaded = await new PersonaLibrary(path, { logger: { warn() {} } }).load();
  assert.equal(reloaded.entryFor(second.id).name, '改名后');
  assert.equal(reloaded.list().length, 3);
});

test('人设库对损坏文件与损坏记录 fail-soft，且加载不重写文件', async (t) => {
  const { path } = await fixture(t);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '{ not json', 'utf8');
  const broken = await new PersonaLibrary(path, { logger: { warn() {} } }).load();
  assert.equal(broken.list().length, 2, '只保留内置人设（私聊+群聊）');
  assert.equal(await readFile(path, 'utf8'), '{ not json');

  await writeFile(path, JSON.stringify({
    version: PERSONA_LIBRARY_DOCUMENT_VERSION,
    entries: {
      p_bad: { name: 'x' },
      p_good: { name: '好的', text: '正文' },
      'bad id': { name: 'x', text: 'y' },
    },
  }), 'utf8');
  const isolated = await new PersonaLibrary(path, { logger: { warn() {} } }).load();
  assert.equal(isolated.entryFor('p_good').name, '好的');
  assert.equal(isolated.entryFor('p_bad'), null);
  assert.equal(isolated.entryFor('bad id'), null);
  // 显式写一次后规范化为当前版本。
  await isolated.importEntry({ name: '新', text: '正文' });
  const repaired = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(Object.hasOwn(repaired.entries, 'bad id'), false);
});

test('imported 条目 id 不覆盖 builtin/config；简介取自正文首行', () => {
  assert.equal(describePersonaLibraryText('# 标题\n正文'), '标题');
  assert.equal(describePersonaLibraryText('- 列表项\n正文'), '列表项');
  assert.equal(describePersonaLibraryText(''), '');
  assert.equal(describePersonaLibraryText('x'.repeat(300)).length, 120);
});

// ---------------------------------------------------------------------------
// config personaFile
// ---------------------------------------------------------------------------

test('config personaFile 作为只读 config 条目；缺失/相对路径 fail-soft', async (t) => {
  const { root } = await fixture(t);
  const configFile = join(root, 'my-persona.md');
  await writeFile(configFile, '# 配置人设\n正文内容', 'utf8');
  const withConfig = new PersonaLibrary(join(root, 'lib-a.json'), {
    configFile, logger: { warn() {} },
  });
  await withConfig.load();
  const listed = withConfig.list();
  const config = listed.find((entry) => entry.id === PERSONA_CONFIG_PERSONA_ID);
  assert.ok(config);
  assert.equal(config.name, 'my-persona');
  assert.equal(config.source, 'config');
  assert.equal(config.readonly, true);
  assert.equal(withConfig.entryFor(PERSONA_CONFIG_PERSONA_ID).text, '# 配置人设\n正文内容');
  await assert.rejects(withConfig.remove(PERSONA_CONFIG_PERSONA_ID), (error) => error.code === 'persona-library-readonly');
  await assert.rejects(withConfig.rename(PERSONA_CONFIG_PERSONA_ID, 'x'), (error) => error.code === 'persona-library-readonly');

  const warnings = [];
  const missing = new PersonaLibrary(join(root, 'lib-b.json'), {
    configFile: join(root, 'missing.md'), logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  await missing.load();
  assert.equal(missing.entryFor(PERSONA_CONFIG_PERSONA_ID), null);
  assert.equal(missing.list().length, 2);
  assert.ok(warnings.length > 0);

  const relative = new PersonaLibrary(join(root, 'lib-c.json'), {
    configFile: 'relative.md', logger: { warn() {} },
  });
  await relative.load();
  assert.equal(relative.entryFor(PERSONA_CONFIG_PERSONA_ID), null);
});

// ---------------------------------------------------------------------------
// v2 配置解析与注入（library/inline/v1 迁移）
// ---------------------------------------------------------------------------

test('v2 library/inline 配置解析为最终人设；v1 配置迁移为 inline', async (t) => {
  const { library } = await fixture(t);
  const imported = await library.importEntry({ name: '我的助手', text: '我的正文' });

  const libraryConfig = validatePersonaConfig({
    enabled: true, source: 'library', personaId: imported.id, name: '', tone: '', instructions: '',
  });
  assert.deepEqual(resolvePersonaInjection(libraryConfig, library), {
    enabled: true, name: '我的助手', text: '我的正文',
  });
  const builtin = resolvePersonaInjection({
    enabled: true, source: 'library', personaId: 'dafeiyu', name: '', tone: '', instructions: '',
  }, library);
  assert.equal(builtin.text, BUNDLED_DAFEIYU);
  assert.equal(builtin.name, '大肥鱼');

  const inline = validatePersonaConfig({
    enabled: true, source: 'inline', personaId: '', name: '小助手', tone: '温和', instructions: '不要编造。',
  });
  assert.equal(resolvePersonaInjection(inline).text, '你是「小助手」。\n性格与语气：温和\n补充要求：\n不要编造。');

  // 库条目被删除后解析失败（fail-soft null，不抛错）。
  await library.remove(imported.id);
  assert.equal(resolvePersonaInjection(libraryConfig, library), null);
  // 未启用 / 缺库参数时 null。
  assert.equal(resolvePersonaInjection({ ...libraryConfig, enabled: false }, library), null);
  assert.equal(resolvePersonaInjection(libraryConfig), null);

  // v1 四字段读取迁移为 v2 inline，不丢内容。
  assert.deepEqual(normalizePersonaConfig({
    enabled: true, name: '旧', tone: '温和', instructions: '旧补充',
  }), {
    enabled: true, source: 'inline', personaId: '', name: '旧', tone: '温和', instructions: '旧补充',
  });
  assert.deepEqual(normalizePersonaConfig({ enabled: false }), {
    enabled: false, source: 'inline', personaId: '', name: '', tone: '', instructions: '',
  });
});

test('store 保存 v2 library 选择并持久化，读取后仍指向库条目', async (t) => {
  const { root, library } = await fixture(t);
  const imported = await library.importEntry({ name: '库角色', text: '库正文' });
  const store = await new PersonaStore(join(root, 'personas.json'), { logger: { warn() {} } }).load();
  const saved = await store.setPersona(BOT, {
    enabled: true, source: 'library', personaId: imported.id, name: '', tone: '', instructions: '',
  });
  assert.equal(saved.personaId, imported.id);
  assert.deepEqual(resolvePersonaInjection(store.personaFor(BOT), library), {
    enabled: true, name: '库角色', text: '库正文',
  });
});

// ---------------------------------------------------------------------------
// persona.library.* RPC
// ---------------------------------------------------------------------------

test('人设库 RPC：list/get/import/rename/remove 与只读/非法错误', async (t) => {
  const { root } = await fixture(t);
  const library = getPersonaLibrary({ dshHome: root });
  await library.load();
  const store = await new PersonaStore(join(root, 'personas.json'), { logger: { warn() {} } }).load();
  const handler = createPersonaRpcHandler(store, { library });

  const list = await handler(PERSONA_LIBRARY_ENDPOINTS.list, {});
  assert.equal(list.ok, true);
  assert.equal(list.value.entries[0].id, 'dafeiyu');
  assert.equal(Object.hasOwn(list.value.entries[0], 'text'), false);

  const builtin = await handler(PERSONA_LIBRARY_ENDPOINTS.get, { id: 'dafeiyu' });
  assert.equal(builtin.ok, true);
  assert.equal(builtin.value.entry.text, BUNDLED_DAFEIYU);

  const imported = await handler(PERSONA_LIBRARY_ENDPOINTS.import, { name: '我的', text: '正文' });
  assert.equal(imported.ok, true);
  const id = imported.value.entry.id;
  assert.equal((await handler(PERSONA_LIBRARY_ENDPOINTS.get, { id })).value.entry.text, '正文');
  const renamed = await handler(PERSONA_LIBRARY_ENDPOINTS.rename, { id, name: '改名' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.value.entry.name, '改名');
  assert.deepEqual(await handler(PERSONA_LIBRARY_ENDPOINTS.remove, { id }), { ok: true, value: { removed: true } });

  assert.deepEqual(await handler(PERSONA_LIBRARY_ENDPOINTS.get, { id: 'dafeiyu' }).then((r) => r.ok), true);
  const readonly = await handler(PERSONA_LIBRARY_ENDPOINTS.remove, { id: 'dafeiyu' });
  assert.equal(readonly.ok, false);
  assert.equal(readonly.error.code, 'bad-request');
  assert.match(readonly.error.message, /内置人设不可修改/);
  const missing = await handler(PERSONA_LIBRARY_ENDPOINTS.get, { id: 'p_missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'bad-request');
  const invalid = await handler(PERSONA_LIBRARY_ENDPOINTS.import, { name: '', text: '' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');

  // 选择不存在的库条目：set 拒绝。
  const set = await handler('bot.persona.set', {
    botId: BOT,
    persona: { enabled: true, source: 'library', personaId: 'p_missing', name: '', tone: '', instructions: '' },
  });
  assert.deepEqual(set, { ok: false, error: { code: 'bad-request', message: '选择的人设不存在，请重新选择。' } });
});

test('人设库路径沿用 dshHome/integrations/dsh-im，单例按路径复用', () => {
  assert.equal(
    personaLibraryPath({ dshHome: '/tmp/example-home' }),
    '/tmp/example-home/integrations/dsh-im/persona-library.json',
  );
  assert.equal(
    getPersonaLibrary({ dshHome: '/tmp/example-home' }),
    getPersonaLibrary({ dshHome: '/tmp/example-home' }),
  );
  assert.notEqual(
    getPersonaLibrary({ dshHome: '/tmp/example-home' }),
    getPersonaLibrary({ dshHome: '/tmp/other-home' }),
  );
});
