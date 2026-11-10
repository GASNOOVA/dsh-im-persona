// 群聊成员画像：字段归一化、合并策略、单行 prompt 文本与人数据上限裁剪。

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createEmptyProfile,
  formatMemberProfile,
  GroupMemberProfiles,
  mergeMemberProfile,
  normalizeMemberProfile,
  PROFILE_LIMITS,
  truncateText,
  uniqueStrings,
} from '../src/channels/shared/group-brain/member-profiles.mjs';
import { GroupBrainStore } from '../src/channels/shared/group-brain/group-store.mjs';

/** 内存版画像存储：记录保存次数，可模拟读失败。 */
function fakeStore(initial = {}) {
  let saved = structuredClone(initial);
  let saves = 0;
  let failReads = false;
  return {
    async getProfiles() {
      if (failReads) throw new Error('profiles unreadable');
      return structuredClone(saved);
    },
    async saveProfiles(profiles) {
      saves += 1;
      saved = structuredClone(profiles);
    },
    failReads(value) { failReads = value; },
    get saved() { return structuredClone(saved); },
    get saves() { return saves; },
  };
}

async function realStoreFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-group-brain-profiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new GroupBrainStore({ root, channel: 'weixin', botId: 'bot-one', chatId: 'wx-group-1' });
}

test('PROFILE_LIMITS exposes the documented caps', () => {
  assert.deepEqual(PROFILE_LIMITS, {
    displayName: 60,
    summary: 400,
    traits: 6,
    interests: 6,
    speakingStyle: 200,
    relationshipNotes: 400,
  });
  assert.equal(Object.isFrozen(PROFILE_LIMITS), true);
});

test('truncateText collapses whitespace, trims and caps by characters', () => {
  assert.equal(truncateText('  张三 \n 喜欢 跑步 ', 60), '张三 喜欢 跑步');
  assert.equal(truncateText('😀😀😀', 2), '😀😀', 'surrogate pairs are never split');
  assert.equal(truncateText('abcdef', 3), 'abc');
  assert.equal(truncateText('   ', 10), '');
  assert.equal(truncateText(null, 10), '');
  assert.equal(truncateText(42, 10), '');
  assert.equal(truncateText('abc', 0), '');
});

test('uniqueStrings dedupes, trims, drops non-strings and caps the count', () => {
  assert.deepEqual(uniqueStrings(['热心', ' 热心 ', '幽默', '', '热心', 42, null]), ['热心', '幽默']);
  assert.deepEqual(uniqueStrings(['a', 'b', 'c'], 2), ['a', 'b']);
  assert.deepEqual(uniqueStrings('not-an-array'), []);
  assert.deepEqual(uniqueStrings([], 3), []);
  assert.deepEqual(uniqueStrings(['a'], 0), []);
});

test('createEmptyProfile starts from documented defaults and truncates the display name', () => {
  const profile = createEmptyProfile('u1', { displayName: '名'.repeat(80), at: 500 });
  assert.equal(profile.memberId, 'u1');
  assert.equal(profile.displayName.length, PROFILE_LIMITS.displayName);
  assert.deepEqual(profile.traits, []);
  assert.deepEqual(profile.interests, []);
  assert.equal(profile.summary, '');
  assert.equal(profile.speakingStyle, '');
  assert.equal(profile.relationshipNotes, '');
  assert.equal(profile.firstSeenAt, 500);
  assert.equal(profile.lastSeenAt, 500);
  assert.throws(() => createEmptyProfile(''), TypeError);
  assert.throws(() => createEmptyProfile(undefined), TypeError);
});

test('normalizeMemberProfile rejects shapes without a usable member id', () => {
  for (const bad of [null, undefined, [], 'u1', 42, {}, { memberId: '' }, { memberId: '   ' },
    { memberId: 7 }]) {
    assert.equal(normalizeMemberProfile(bad), null, JSON.stringify(bad));
  }
});

test('normalizeMemberProfile clamps every field and de-duplicates arrays', () => {
  const profile = normalizeMemberProfile({
    memberId: ' u1 ',
    displayName: '名'.repeat(80),
    summary: '简'.repeat(500),
    traits: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
    interests: ['x', 'x', 'y', 'z', 'w', 'v', 'u', 't'],
    speakingStyle: '风'.repeat(300),
    relationshipNotes: '关系'.repeat(300),
    firstSeenAt: 1000.9,
    lastSeenAt: 'not-a-time',
  });
  assert.equal(profile.memberId, 'u1');
  assert.equal(profile.displayName.length, PROFILE_LIMITS.displayName);
  assert.equal(profile.summary.length, PROFILE_LIMITS.summary);
  assert.deepEqual(profile.traits, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(profile.interests, ['x', 'y', 'z', 'w', 'v', 'u']);
  assert.equal(profile.speakingStyle.length, PROFILE_LIMITS.speakingStyle);
  assert.equal(profile.relationshipNotes.length, PROFILE_LIMITS.relationshipNotes);
  assert.equal(profile.firstSeenAt, 1000);
  assert.equal(profile.lastSeenAt, null);
});

test('mergeMemberProfile keeps the first sighting and only overwrites text with non-empty updates', () => {
  const existing = {
    memberId: 'u1',
    displayName: '张三',
    summary: '常聊技术',
    traits: ['热心', '幽默'],
    interests: ['跑步'],
    speakingStyle: '简短',
    relationshipNotes: '和群里的人很熟',
    firstSeenAt: 1000,
    lastSeenAt: 2000,
  };
  const merged = mergeMemberProfile(existing, {
    memberId: 'u1',
    displayName: '',
    summary: '最近在学 Rust',
    speakingStyle: '  ',
    traits: ['严谨', '幽默'],
    now: 5000,
  }, { now: 5000 });
  assert.equal(merged.displayName, '张三', 'an empty update never clears an accumulated field');
  assert.equal(merged.summary, '最近在学 Rust', 'summary is overwritten when the update carries it');
  assert.equal(merged.speakingStyle, '简短');
  assert.equal(merged.relationshipNotes, '和群里的人很熟');
  assert.deepEqual(merged.traits, ['热心', '幽默', '严谨'], 'arrays merge as a deduplicated union');
  assert.deepEqual(merged.interests, ['跑步']);
  assert.equal(merged.firstSeenAt, 1000, 'firstSeenAt is preserved');
  assert.equal(merged.lastSeenAt, 5000);
});

test('mergeMemberProfile unions arrays up to the cap and truncates long items', () => {
  const merged = mergeMemberProfile(
    { memberId: 'u1', traits: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { memberId: 'u1', traits: ['g', 'h', 'i', 'a', 't'.repeat(200)], interests: ['i1', 'i2'] },
    { now: 10 },
  );
  assert.equal(merged.traits.length, PROFILE_LIMITS.traits);
  assert.deepEqual(merged.traits.slice(0, 6), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(merged.interests.length, 2);
});

test('mergeMemberProfile never moves lastSeenAt backwards', () => {
  const merged = mergeMemberProfile(
    { memberId: 'u1', firstSeenAt: 100, lastSeenAt: 900 },
    { memberId: 'u1', summary: 'x' },
    { now: 500 },
  );
  assert.equal(merged.firstSeenAt, 100);
  assert.equal(merged.lastSeenAt, 900);
});

test('mergeMemberProfile creates a profile from an update with no existing record', () => {
  const merged = mergeMemberProfile(null, {
    memberId: 'u1', displayName: '李四', traits: ['细心'], summary: '爱帮忙',
  }, { now: 700 });
  assert.equal(merged.memberId, 'u1');
  assert.equal(merged.displayName, '李四');
  assert.deepEqual(merged.traits, ['细心']);
  assert.equal(merged.firstSeenAt, 700);
  assert.equal(merged.lastSeenAt, 700);
  // 两边都没有 memberId：返回 null，由调用方跳过，而不是伪造一个成员。
  assert.equal(mergeMemberProfile(null, { displayName: '无 id' }), null);
  assert.equal(mergeMemberProfile({ displayName: '旧画像无 id' }, null), null);
});

test('formatMemberProfile renders one deterministic Chinese line without newlines', () => {
  const line = formatMemberProfile({
    memberId: 'u1',
    displayName: '张三\n（群友）',
    traits: ['热心', '幽默'],
    interests: ['跑步'],
    speakingStyle: '简短',
    relationshipNotes: '常帮新人',
    summary: '常聊技术',
    firstSeenAt: 1,
    lastSeenAt: 2,
  });
  assert.equal(line, '成员 张三 （群友）；性格 热心、幽默；兴趣 跑步；说话风格 简短；关系 常帮新人；简介 常聊技术');
  assert.doesNotMatch(line, /\n/u);
  assert.equal(formatMemberProfile(null), '');
  assert.equal(formatMemberProfile({ memberId: 'u2' }), '成员 u2');
});

test('GroupMemberProfiles requires a persistent store', () => {
  assert.throws(() => new GroupMemberProfiles(), TypeError);
  assert.throws(() => new GroupMemberProfiles({ store: { getProfiles() {} } }), TypeError);
  assert.throws(() => new GroupMemberProfiles({ store: { saveProfiles() {} } }), TypeError);
});

test('load reads stored profiles, skips invalid entries and applies the person cap', async () => {
  const store = fakeStore({
    u1: { memberId: 'u1', displayName: '张三', lastSeenAt: 100 },
    broken: { displayName: '没有 id' },
    u2: { memberId: 'u2', displayName: '李四', lastSeenAt: 300 },
    u3: { memberId: 'u3', displayName: '王五', lastSeenAt: 200 },
  });
  const profiles = new GroupMemberProfiles({ store, maxProfiles: 2 });
  await profiles.load();
  assert.equal(profiles.size, 2);
  assert.deepEqual(profiles.list().map((profile) => profile.memberId), ['u2', 'u3']);
  assert.equal(profiles.get('u1'), null);
  assert.equal(store.saves, 0, 'a load-only prune does not rewrite the file');
});

test('load fails soft when the store cannot read profiles', async () => {
  const store = fakeStore({});
  store.failReads(true);
  const profiles = new GroupMemberProfiles({ store });
  await profiles.load();
  assert.deepEqual(profiles.list(), []);
  assert.equal(profiles.get('u1'), null);
});

test('upsert merges, persists and exposes defensive copies', async () => {
  const store = fakeStore();
  let clock = 1000;
  const profiles = new GroupMemberProfiles({ store, now: () => clock });
  await profiles.load();
  assert.deepEqual(await profiles.upsert({ memberId: 'u1', displayName: '张三', traits: ['热心'] }), {
    memberId: 'u1',
    displayName: '张三',
    summary: '',
    traits: ['热心'],
    interests: [],
    speakingStyle: '',
    relationshipNotes: '',
    firstSeenAt: 1000,
    lastSeenAt: 1000,
  });
  clock = 2000;
  const merged = await profiles.upsert({ memberId: 'u1', traits: ['幽默'], summary: '常聊技术' });
  assert.deepEqual(merged.traits, ['热心', '幽默']);
  assert.equal(merged.firstSeenAt, 1000);
  assert.equal(merged.lastSeenAt, 2000);
  assert.equal(store.saves, 2);
  // 返回值与内部状态隔离：改返回值不会污染下一次读取。
  merged.traits.push('注入');
  assert.deepEqual(profiles.get('u1').traits, ['热心', '幽默']);
  profiles.get('u1').traits.push('再注入');
  assert.deepEqual(profiles.list()[0].traits, ['热心', '幽默']);
  assert.equal(await profiles.upsert({ memberId: '' }), null, 'invalid updates are ignored');
  assert.equal(profiles.size, 1);
});

test('list sorts by most recent sighting and upsertMany saves once', async () => {
  const store = fakeStore();
  let clock = 0;
  const profiles = new GroupMemberProfiles({ store, maxProfiles: 10, now: () => clock });
  await profiles.load();
  clock = 100;
  await profiles.upsertMany([{ memberId: 'u1', displayName: '张三' }, { memberId: 'u2', displayName: '李四' }]);
  assert.equal(store.saves, 1, 'a batch saves once');
  clock = 200;
  await profiles.upsertMany([{ memberId: 'u2', summary: '常聊技术' }, null, { memberId: '  ' }]);
  assert.equal(store.saves, 2);
  assert.deepEqual(profiles.list().map((profile) => profile.memberId), ['u2', 'u1']);
  assert.equal(profiles.list()[0].summary, '常聊技术');
});

test('constructor maxProfiles keeps only the most recently seen members', async () => {
  const store = fakeStore();
  let clock = 0;
  const profiles = new GroupMemberProfiles({ store, maxProfiles: 3, now: () => clock });
  await profiles.load();
  for (const memberId of ['u1', 'u2', 'u3', 'u4', 'u5']) {
    clock += 100;
    await profiles.upsert({ memberId, displayName: memberId });
  }
  assert.equal(profiles.size, 3);
  assert.deepEqual(profiles.list().map((profile) => profile.memberId), ['u5', 'u4', 'u3']);
  assert.deepEqual(Object.keys(store.saved).sort(), ['u3', 'u4', 'u5']);
  // 非法上限回退默认 5：0 在构造时等价于 5。
  const fallback = new GroupMemberProfiles({ store: fakeStore(), maxProfiles: 0, now: () => clock });
  await fallback.load();
  for (const memberId of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']) {
    clock += 100;
    await fallback.upsert({ memberId });
  }
  assert.equal(fallback.size, 5);
});

test('pruneTo removes the oldest profiles, persists and reports what it removed', async () => {
  const store = fakeStore();
  let clock = 0;
  const profiles = new GroupMemberProfiles({ store, maxProfiles: 10, now: () => clock });
  await profiles.load();
  for (const memberId of ['u1', 'u2', 'u3']) {
    clock += 100;
    await profiles.upsert({ memberId });
  }
  const savesBefore = store.saves;
  const result = await profiles.pruneTo(2);
  assert.deepEqual(result, { removed: ['u1'], size: 2 });
  assert.deepEqual(profiles.list().map((profile) => profile.memberId), ['u3', 'u2']);
  assert.equal(store.saves, savesBefore + 1);
  await assert.rejects(profiles.pruneTo(0), TypeError);
  await assert.rejects(profiles.pruneTo(1.5), TypeError);
});

test('GroupMemberProfiles persists through the real GroupBrainStore and survives a reload', async (t) => {
  const store = await realStoreFixture(t);
  let clock = 100;
  const profiles = new GroupMemberProfiles({ store, maxProfiles: 5, now: () => clock });
  await profiles.load();
  await profiles.upsert({ memberId: 'u1', displayName: '张三', traits: ['热心'], summary: '常聊技术' });
  clock = 200;
  await profiles.upsertMany([
    { memberId: 'u2', displayName: '李四', interests: ['跑步'] },
    { memberId: 'u3', displayName: '王五' },
  ]);
  const stored = await store.getProfiles();
  assert.deepEqual(Object.keys(stored).sort(), ['u1', 'u2', 'u3']);
  assert.equal(stored.u1.displayName, '张三');

  const reloaded = new GroupMemberProfiles({ store, maxProfiles: 5, now: () => clock });
  await reloaded.load();
  // u2 与 u3 在同一批次里写入，lastSeenAt 相同，按 memberId 稳定排序。
  assert.deepEqual(reloaded.list().map((profile) => profile.memberId), ['u2', 'u3', 'u1']);
  assert.deepEqual(reloaded.get('u1').traits, ['热心']);

  await reloaded.pruneTo(1);
  assert.deepEqual(Object.keys(await store.getProfiles()), ['u2']);
});
