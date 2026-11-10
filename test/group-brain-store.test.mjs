// 群聊大脑存储层：目录隔离、去重、流式/尾部读取、长期记忆、state 原子更新与 fail-soft。
//
// 每个用例使用独立的 os.tmpdir() 目录，结束时删除；不使用真实 DSH_HOME。

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GroupBrainStore,
  groupStorageKey,
  MAX_KEPT_MESSAGE_IDS,
  MEMORY_COMPRESSED_MARKER,
} from '../src/channels/shared/group-brain/group-store.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-group-brain-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GroupBrainStore({
    root,
    channel: 'qq',
    botId: 'bot-one',
    chatId: 'group-openid-1',
    groupName: '测试群',
    ...options,
  });
  return { root, store };
}

async function countLines(path) {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).length;
}

function modeOf(info) {
  return info.mode & 0o777;
}

test('groupStorageKey is stable, channel-prefixed and isolates every identity part', () => {
  const base = { channel: 'qq', botId: 'bot-one', chatId: 'group-openid-1' };
  const key = groupStorageKey(base);
  assert.match(key, /^qq-[0-9a-f]{20}$/u);
  assert.equal(groupStorageKey({ ...base }), key, 'same identity gives the same key');
  assert.notEqual(groupStorageKey({ ...base, channel: 'weixin' }), key);
  assert.notEqual(groupStorageKey({ ...base, botId: 'bot-two' }), key);
  assert.notEqual(groupStorageKey({ ...base, chatId: 'group-openid-2' }), key);
  // 字符串拼接若没有分隔符，("a","bc") 与 ("ab","c") 会碰撞；\0 必须保留。
  assert.notEqual(
    groupStorageKey({ channel: 'qq', botId: 'ab', chatId: 'c' }),
    groupStorageKey({ channel: 'qq', botId: 'a', chatId: 'bc' }),
  );
  for (const bad of [undefined, {}, { channel: 'qq' }, { channel: 'qq', botId: '', chatId: 'g' },
    { channel: 'qq', botId: 'b', chatId: 42 }]) {
    assert.throws(() => groupStorageKey(bad), TypeError);
  }
});

test('constructor validates identity and exposes paths under one isolated directory', () => {
  const key = groupStorageKey({ channel: 'qq', botId: 'bot-one', chatId: 'group-openid-1' });
  const store = new GroupBrainStore({
    root: '/tmp/root-example', channel: 'qq', botId: 'bot-one', chatId: 'group-openid-1',
  });
  assert.deepEqual(store.identity, { channel: 'qq', botId: 'bot-one', chatId: 'group-openid-1' });
  assert.equal(store.paths.directory, join('/tmp/root-example', key));
  assert.equal(store.paths.messages, join(store.paths.directory, 'messages.jsonl'));
  assert.equal(store.paths.state, join(store.paths.directory, 'state.json'));
  assert.equal(store.paths.profiles, join(store.paths.directory, 'profiles.json'));
  assert.equal(store.paths.memory, join(store.paths.directory, 'memory.md'));
  for (const bad of [undefined, {}, { root: '', channel: 'qq', botId: 'b', chatId: 'c' },
    { root: '/r', channel: 'qq', botId: 'b' }, { root: '/r', channel: 'qq', botId: 'b', chatId: '  ' }]) {
    assert.throws(() => new GroupBrainStore(bad), TypeError);
  }
});

test('load creates a private directory and reports empty state', async (t) => {
  const { store } = await fixture(t);
  await store.load();
  const directory = await stat(store.paths.directory);
  assert.equal(directory.isDirectory(), true);
  assert.equal(modeOf(directory), 0o700);
  assert.deepEqual(await store.getInfo(), {
    channel: 'qq',
    botId: 'bot-one',
    chatId: 'group-openid-1',
    groupName: '测试群',
    memberIds: [],
    messageCount: 0,
    lastMessageAt: null,
    lastConsolidatedAt: null,
  });
  const state = await store.getState();
  assert.deepEqual(state.messageIds, []);
  assert.equal(state.messageCount, 0);
});

test('recordMessage appends JSONL and tracks count, members and time bounds', async (t) => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.recordMessage({
    messageId: 'm1', senderId: 'u1', senderName: '张三', text: 'hello', at: 1000,
  }), { duplicate: false, messageCount: 1 });
  await store.recordMessage({ messageId: 'm2', senderId: 'u1', text: 'again', at: 2000 });
  // 乱序到达的旧消息不能把 lastMessageAt 拉回去。
  await store.recordMessage({ messageId: 'm3', senderId: 'u2', text: 'old', at: 1500 });
  const info = await store.getInfo();
  assert.equal(info.messageCount, 3);
  assert.equal(info.lastMessageAt, 2000);
  assert.deepEqual(info.memberIds, ['u1', 'u2']);
  assert.equal(await countLines(store.paths.messages), 3);
  const state = await store.getState();
  assert.equal(state.firstMessageAt, 1000);
  assert.deepEqual(state.messageIds, ['m1', 'm2', 'm3']);
  const lines = (await readFile(store.paths.messages, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], {
    messageId: 'm1',
    senderId: 'u1',
    senderName: '张三',
    text: 'hello',
    mentionedBot: false,
    at: 1000,
    kind: 'group',
    meta: {},
  });
  assert.equal(lines[2].messageId, 'm3');
});

test('duplicate message ids are ignored without appending', async (t) => {
  const { store } = await fixture(t);
  await store.recordMessage({ messageId: 'm1', senderId: 'u1', text: 'first', at: 1000 });
  assert.deepEqual(
    await store.recordMessage({ messageId: 'm1', senderId: 'u1', text: 'retry', at: 1001 }),
    { duplicate: true, messageCount: 1 },
  );
  assert.equal(await countLines(store.paths.messages), 1);
  const recent = await store.recentMessages();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].text, 'first', 'the first accepted copy wins');
});

test('state keeps only the most recent message ids for dedupe after restart', async (t) => {
  const { store, root } = await fixture(t);
  for (let index = 0; index <= MAX_KEPT_MESSAGE_IDS; index += 1) {
    await store.recordMessage({ messageId: `m${index}`, senderId: 'u1', at: index });
  }
  const state = await store.getState();
  assert.equal(state.messageCount, MAX_KEPT_MESSAGE_IDS + 1);
  assert.equal(state.messageIds.length, MAX_KEPT_MESSAGE_IDS);
  assert.equal(state.messageIds[0], `m1`);
  assert.equal(state.messageIds.at(-1), `m${MAX_KEPT_MESSAGE_IDS}`);

  // 新进程只认 state 里的 500 个：窗口内的重复仍去重，滑出窗口的旧 id 允许重新记录。
  const restarted = new GroupBrainStore({
    root, channel: 'qq', botId: 'bot-one', chatId: 'group-openid-1',
  });
  await restarted.load();
  assert.equal((await restarted.recordMessage({ messageId: `m${MAX_KEPT_MESSAGE_IDS}`, at: 9999 })).duplicate, true);
  assert.equal((await restarted.recordMessage({ messageId: 'm0', at: 9999 })).duplicate, false);
});

test('concurrent recordMessage calls are serialized without losing counts', async (t) => {
  const { store } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
    store.recordMessage({ messageId: `c${index}`, senderId: `u${index % 3}`, at: 1000 + index })));
  assert.equal(results.every((result) => result.duplicate === false), true);
  assert.equal(await countLines(store.paths.messages), 40);
  const info = await store.getInfo();
  assert.equal(info.messageCount, 40);
  assert.deepEqual(info.memberIds, ['u0', 'u1', 'u2']);
  const state = await store.getState();
  assert.equal(new Set(state.messageIds).size, 40);
});

test('concurrent duplicate records append exactly one line', async (t) => {
  const { store } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    store.recordMessage({ messageId: 'same-id', senderId: 'u1', at: 1000 })));
  assert.equal(results.filter((result) => result.duplicate === false).length, 1);
  assert.equal(await countLines(store.paths.messages), 1);
  assert.equal((await store.getInfo()).messageCount, 1);
});

test('messagesSince streams only records at or after the timestamp', async (t) => {
  const { store } = await fixture(t);
  for (const [index, at] of [0, 1000, 2000, 3000, 4000].entries()) {
    await store.recordMessage({ messageId: `m${index}`, senderId: 'u1', at });
  }
  const collect = async (since, options) => {
    const ids = [];
    for await (const record of store.messagesSince(since, options)) ids.push(record.messageId);
    return ids;
  };
  assert.deepEqual(await collect(0), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.deepEqual(await collect(1500), ['m2', 'm3', 'm4']);
  assert.deepEqual(await collect(1500, { limitMessages: 2 }), ['m2', 'm3']);
  assert.deepEqual(await collect(99_999), []);
  // 不存在的消息文件是「没有消息」，不是错误。
  const { store: empty } = await fixture(t);
  const fromEmpty = [];
  for await (const record of empty.messagesSince(0)) fromEmpty.push(record);
  assert.deepEqual(fromEmpty, []);
});

test('recentMessages returns the newest records and tolerates a missing file', async (t) => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.recentMessages(), []);
  for (let index = 0; index < 10; index += 1) {
    await store.recordMessage({ messageId: `m${index}`, senderId: 'u1', text: `t${index}`, at: index });
  }
  assert.deepEqual((await store.recentMessages(3)).map((record) => record.messageId), ['m7', 'm8', 'm9']);
  assert.equal((await store.recentMessages()).length, 10);
  // 非法 limit 回退默认 50，而不是抛错。
  assert.equal((await store.recentMessages(0)).length, 10);
});

test('recentMessages reads only the tail of a large JSONL file', async (t) => {
  const { store } = await fixture(t);
  await store.load();
  const lines = Array.from({ length: 3200 }, (_, index) => JSON.stringify({
    messageId: `bulk-${index}`,
    senderId: 'u1',
    senderName: '',
    text: 'x'.repeat(900),
    mentionedBot: false,
    at: index,
    kind: 'group',
    meta: {},
  }));
  await writeFile(store.paths.messages, `${lines.join('\n')}\n`, { mode: 0o600 });
  assert.ok((await stat(store.paths.messages)).size > 2 * 1024 * 1024, 'fixture exceeds the tail threshold');
  const recent = await store.recentMessages(5);
  assert.deepEqual(recent.map((record) => record.messageId), ['bulk-3195', 'bulk-3196', 'bulk-3197', 'bulk-3198', 'bulk-3199']);
  assert.equal(recent[0].text.length, 900, 'the partial first line of the tail chunk is dropped cleanly');
});

test('memory round-trips, missing file reads as empty and empty save clears it', async (t) => {
  const { store } = await fixture(t);
  await store.load();
  assert.equal(await store.getMemory(), '');
  assert.equal(await store.saveMemory('张三喜欢聊跑步。\n李四常分享技术文章。'), '张三喜欢聊跑步。\n李四常分享技术文章。');
  assert.equal(await store.getMemory(), '张三喜欢聊跑步。\n李四常分享技术文章。');
  assert.equal(modeOf(await stat(store.paths.memory)), 0o600);
  await store.saveMemory('');
  assert.equal(await store.getMemory(), '');
  await assert.rejects(store.saveMemory(null), TypeError);
});

test('memory keeps the newest tail with a compression marker when too long', async (t) => {
  const { store } = await fixture(t);
  const long = `${'old-'.repeat(30)}${'newest'.repeat(10)}`;
  const saved = await store.saveMemory(long, { maxChars: 20 });
  assert.ok(saved.startsWith(`${MEMORY_COMPRESSED_MARKER}\n`));
  assert.equal(saved.slice(MEMORY_COMPRESSED_MARKER.length + 1), long.slice(-20));
  assert.equal(await store.getMemory(), saved);
  // 未超长时逐字保留，不做任何改动。
  assert.equal(await store.saveMemory('恰恰好呀', { maxChars: 3 }), '（更早记忆已压缩）\n恰好呀');
  assert.equal(await store.saveMemory('abcdef', { maxChars: 10 }), 'abcdef');
});

test('profiles round-trip and damaged files fail soft with a warning', async (t) => {
  const warnings = [];
  const { store } = await fixture(t, { logger: { warn: (...args) => warnings.push(args) } });
  await store.load();
  assert.deepEqual(await store.getProfiles(), {});
  const profiles = {
    u1: { memberId: 'u1', displayName: '张三', traits: ['热心'], firstSeenAt: 1, lastSeenAt: 2 },
    u2: { memberId: 'u2', summary: '常聊技术' },
  };
  await store.saveProfiles(profiles);
  assert.deepEqual(await store.getProfiles(), profiles);
  assert.equal(modeOf(await stat(store.paths.profiles)), 0o600);
  await assert.rejects(store.saveProfiles(null), TypeError);
  await assert.rejects(store.saveProfiles({ u1: 'not-an-object' }), TypeError);

  await writeFile(store.paths.profiles, '{broken', { mode: 0o600 });
  assert.deepEqual(await store.getProfiles(), {});
  assert.ok(warnings.length >= 1, 'a damaged profiles file is reported to the logger');
  await writeFile(store.paths.profiles, `${JSON.stringify({ version: 1, profiles: [] })}\n`);
  assert.deepEqual(await store.getProfiles(), {});
});

test('updateState merges atomically, preserves unknown fields and returns copies', async (t) => {
  const { store } = await fixture(t);
  await store.recordMessage({ messageId: 'm1', senderId: 'u1', at: 1000 });
  const first = await store.updateState({ lastConsolidatedAt: 5000, lastAmbientAt: 700 });
  assert.equal(first.lastConsolidatedAt, 5000);
  assert.equal(first.lastAmbientAt, 700);
  assert.equal(first.messageCount, 1);
  assert.equal((await store.getInfo()).lastConsolidatedAt, 5000);
  const second = await store.updateState({ lastConsolidatedAt: 6000 });
  assert.equal(second.lastConsolidatedAt, 6000);
  assert.equal(second.lastAmbientAt, 700, 'unknown extension fields survive later updates');
  // 返回值是深拷贝：改它不影响下一次读取。
  second.messageIds.push('injected');
  assert.deepEqual((await store.getState()).messageIds, ['m1']);
  await assert.rejects(store.updateState([]), TypeError);
});

test('a damaged state file starts from defaults instead of failing', async (t) => {
  const warnings = [];
  const { store, root } = await fixture(t, { logger: { warn: (...args) => warnings.push(args) } });
  await store.load();
  await writeFile(store.paths.state, '{broken', { mode: 0o600 });
  const restarted = new GroupBrainStore({
    root,
    channel: 'qq',
    botId: 'bot-one',
    chatId: 'group-openid-1',
    logger: { warn: (...args) => warnings.push(args) },
  });
  const info = await restarted.getInfo();
  assert.equal(info.messageCount, 0);
  assert.equal(info.lastMessageAt, null);
  assert.deepEqual(info.memberIds, []);
  assert.ok(warnings.length >= 1, 'the damaged state is reported to the logger');
  // 坏文件不能让群彻底失联：能继续记录，并写出新的合法 state。
  assert.deepEqual(await restarted.recordMessage({ messageId: 'm1', senderId: 'u1', at: 1000 }),
    { duplicate: false, messageCount: 1 });
  assert.equal((await restarted.getState()).messageCount, 1);
});

test('a fresh instance sees messages and state written by a previous one', async (t) => {
  const { store, root } = await fixture(t);
  await store.recordMessage({ messageId: 'm1', senderId: 'u1', text: 'hello', at: 1000 });
  await store.recordMessage({ messageId: 'm2', senderId: 'u2', text: 'hi', at: 2000 });
  await store.updateState({ lastConsolidatedAt: 2500 });

  const restarted = new GroupBrainStore({
    root, channel: 'qq', botId: 'bot-one', chatId: 'group-openid-1',
  });
  const info = await restarted.getInfo();
  assert.equal(info.groupName, '测试群', 'a non-empty group name survives a restart');
  assert.equal(info.messageCount, 2);
  assert.deepEqual(info.memberIds, ['u1', 'u2']);
  assert.equal(info.lastMessageAt, 2000);
  assert.equal(info.lastConsolidatedAt, 2500);
  assert.equal((await restarted.recordMessage({ messageId: 'm1', at: 3000 })).duplicate, true);
  assert.deepEqual((await restarted.recentMessages()).map((record) => record.messageId), ['m1', 'm2']);
});

test('recordMessage validates its message id', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.recordMessage({}), TypeError);
  await assert.rejects(store.recordMessage({ messageId: '   ' }), TypeError);
  await assert.rejects(store.recordMessage({ messageId: 42 }), TypeError);
});

test('data directory and files use private permission bits', async (t) => {
  const { store } = await fixture(t);
  await store.load();
  await store.recordMessage({ messageId: 'm1', senderId: 'u1', at: 1000 });
  await store.saveMemory('记忆');
  await store.saveProfiles({ u1: { memberId: 'u1' } });
  assert.equal(modeOf(await stat(store.paths.directory)), 0o700);
  for (const path of [store.paths.messages, store.paths.state, store.paths.profiles, store.paths.memory]) {
    assert.equal(modeOf(await stat(path)), 0o600, path);
  }
});
