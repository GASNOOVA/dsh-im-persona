// 群聊版大肥鱼人设测试：私聊版/群聊版是两条独立 builtin，私聊原文一字不改，
// 群聊版正文 = 原文 + 群聊行为准则，附加准则按 id 解析。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  BUNDLED_DAFEIYU,
  BUNDLED_DAFEIYU_DESCRIPTION,
  BUNDLED_DAFEIYU_GROUP,
  BUNDLED_DAFEIYU_GROUP_DESCRIPTION,
  DAFEIYU_GROUP_ADDON,
  GROUP_PERSONA_ADDONS,
  PERSONA_PRESETS,
  PERSONA_PRESET_IDS,
  personaPresetFor,
  resolveGroupPersonaAddon,
} from '../src/channels/shared/persona-presets.mjs';

/** 参考实现 dsh-persona-dafeiyu 里大肥鱼原文（635 字符）的 SHA-256。 */
const ORIGINAL_TEXT_SHA256 = 'cf726b607b2517a53e087ad1fd278e2c4c3134d0f50f121d9a0489a22f42c9c0';
/** 原始界面简介的 SHA-256。 */
const ORIGINAL_DESCRIPTION_SHA256 = '9b955fdadb3fad9b08f889b53c65a225ceed9758b6d3f22798228c47d0e77480';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test('PERSONA_PRESETS：私聊版与群聊版是两条独立 builtin', () => {
  assert.equal(PERSONA_PRESETS.length, 2);
  assert.deepEqual(PERSONA_PRESETS.map((preset) => preset.id), ['dafeiyu', 'dafeiyu-group']);
  assert.deepEqual(PERSONA_PRESET_IDS, ['dafeiyu', 'dafeiyu-group']);
  for (const preset of PERSONA_PRESETS) {
    assert.equal(preset.source, 'builtin');
    assert.equal(Object.isFrozen(preset), true);
  }
  assert.equal(Object.isFrozen(PERSONA_PRESETS), true);
});

test('私聊版 dafeiyu：正文与简介保持参考实现原样（哈希对照）', () => {
  assert.equal(sha256(BUNDLED_DAFEIYU), ORIGINAL_TEXT_SHA256);
  assert.equal(BUNDLED_DAFEIYU.length, 635);
  assert.equal(sha256(BUNDLED_DAFEIYU_DESCRIPTION), ORIGINAL_DESCRIPTION_SHA256);

  const preset = personaPresetFor('dafeiyu');
  assert.equal(preset.text, BUNDLED_DAFEIYU);
  assert.equal(preset.name, '大肥鱼');
  assert.equal(preset.description, BUNDLED_DAFEIYU_DESCRIPTION);
  // 私聊原文里不应混入群聊准则。
  assert.equal(BUNDLED_DAFEIYU.includes('群聊行为准则'), false);
  assert.equal(BUNDLED_DAFEIYU.includes('[SKIP]'), false);
});

test('群聊版 dafeiyu-group：正文 = 私聊原文 + 群聊准则，简介独立', () => {
  assert.equal(BUNDLED_DAFEIYU_GROUP, `${BUNDLED_DAFEIYU}\n\n${DAFEIYU_GROUP_ADDON}`);

  const preset = personaPresetFor('dafeiyu-group');
  assert.equal(preset.name, '大肥鱼（群聊版）');
  assert.equal(preset.text, BUNDLED_DAFEIYU_GROUP);
  assert.equal(preset.description, BUNDLED_DAFEIYU_GROUP_DESCRIPTION);
  assert.equal(
    preset.description,
    '大肥鱼群聊版：像群里的胖鱼朋友，平时安静潜水，被 @ 时认真干活，话题停顿时自然接一句；不刷屏、不总结、不 @ 人。',
  );
  assert.equal(preset.text.startsWith(BUNDLED_DAFEIYU), true);
  assert.equal(preset.text.endsWith(DAFEIYU_GROUP_ADDON), true);
  assert.equal(preset.text.length, BUNDLED_DAFEIYU.length + 2 + DAFEIYU_GROUP_ADDON.length);
});

test('DAFEIYU_GROUP_ADDON：覆盖任务要求的群聊行为准则', () => {
  assert.equal(typeof DAFEIYU_GROUP_ADDON, 'string');
  for (const keyword of ['群友', '客服', '安静', '@', '[SKIP]', '80', '成员画像']) {
    assert.ok(DAFEIYU_GROUP_ADDON.includes(keyword), `群聊准则应包含「${keyword}」`);
  }
  // 准则只是附加段，不包含私聊人设标题，避免与原文重复。
  assert.equal(DAFEIYU_GROUP_ADDON.includes('# 人设：大肥鱼'), false);
});

test('GROUP_PERSONA_ADDONS 冻结，且私聊/群聊两个 id 都指向同一套群聊准则', () => {
  assert.equal(Object.isFrozen(GROUP_PERSONA_ADDONS), true);
  assert.equal(GROUP_PERSONA_ADDONS.dafeiyu, DAFEIYU_GROUP_ADDON);
  assert.equal(GROUP_PERSONA_ADDONS['dafeiyu-group'], DAFEIYU_GROUP_ADDON);
});

test('resolveGroupPersonaAddon：已知 id 返回准则，未知/非字符串返回空串', () => {
  assert.equal(resolveGroupPersonaAddon('dafeiyu'), DAFEIYU_GROUP_ADDON);
  assert.equal(resolveGroupPersonaAddon('dafeiyu-group'), DAFEIYU_GROUP_ADDON);
  for (const value of ['nope', '', null, undefined, 123, 'toString']) {
    assert.equal(resolveGroupPersonaAddon(value), '', `unknown ${String(value)} should return ''`);
  }
});

test('personaPresetFor：两条 builtin 均可按 id 取到，未知返回 null', () => {
  assert.equal(personaPresetFor('dafeiyu').id, 'dafeiyu');
  assert.equal(personaPresetFor('dafeiyu-group').id, 'dafeiyu-group');
  assert.equal(personaPresetFor('nope'), null);
  assert.equal(personaPresetFor(null), null);
});
