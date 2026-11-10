import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  clearGroupBrainSessionRegistries,
  getGroupBrainSessionRegistry,
  groupBrainSessionKey,
  groupBrainSessionsPath,
} from '../plugin-src/host/group-brain-sessions.mjs';
import {
  createHarnessGroupBrainGenerator,
  persistentGroupSessionTitle,
} from '../plugin-src/host/group-brain-runtime.mjs';

function fakeHarness() {
  const calls = { created: [], asked: [], renamed: [], archived: [] };
  let nextId = 1;
  return {
    calls,
    async createSession() {
      const id = `session-${nextId}`;
      nextId += 1;
      calls.created.push(id);
      return id;
    },
    async ask(sessionId, prompt) {
      calls.asked.push({ sessionId, prompt });
      return `reply:${sessionId}:${calls.asked.length}`;
    },
    async renameSession(sessionId, title) {
      calls.renamed.push({ sessionId, title });
    },
    async archiveWorkspaceSession(sessionId) {
      calls.archived.push(sessionId);
    },
  };
}

async function fixture(t) {
  const dshHome = await mkdtemp(join(tmpdir(), 'group-brain-runtime-'));
  clearGroupBrainSessionRegistries();
  t.after(async () => {
    clearGroupBrainSessionRegistries();
    await rm(dshHome, { recursive: true, force: true });
  });
  return { dshHome };
}

test('reuses one DSH session for every reply in the same group', async (t) => {
  const { dshHome } = await fixture(t);
  const harness = fakeHarness();
  const generate = createHarnessGroupBrainGenerator({
    harness,
    channel: 'wechat-personal',
    botId: 'xiaohao',
    dshHome,
    logger: { warn() {} },
  });

  const first = await generate({ kind: 'direct', prompt: 'hello', meta: { chatId: 'group-1', groupName: '👫' } });
  const second = await generate({ kind: 'follow-up', prompt: 'again', meta: { chatId: 'group-1', groupName: '👫' } });

  assert.equal(first, 'reply:session-1:1');
  assert.equal(second, 'reply:session-1:2');
  assert.deepEqual(harness.calls.created, ['session-1']);
  assert.deepEqual(harness.calls.asked.map((call) => call.sessionId), ['session-1', 'session-1']);
  assert.deepEqual(harness.calls.archived, []);
  assert.deepEqual(harness.calls.renamed, [{ sessionId: 'session-1', title: '群聊 · 👫' }]);

  const registry = getGroupBrainSessionRegistry({ dshHome });
  const records = await registry.list();
  assert.equal(records.length, 1);
  const key = groupBrainSessionKey('wechat-personal', 'xiaohao', 'group-1');
  assert.equal(records[0].key, key);
  assert.equal(records[0].sessionId, 'session-1');
});

test('keeps a separate DSH session per group', async (t) => {
  const { dshHome } = await fixture(t);
  const harness = fakeHarness();
  const generate = createHarnessGroupBrainGenerator({
    harness,
    channel: 'wechat-personal',
    botId: 'xiaohao',
    dshHome,
    logger: { warn() {} },
  });

  await generate({ kind: 'direct', prompt: 'a', meta: { chatId: 'group-a', groupName: 'A群' } });
  await generate({ kind: 'direct', prompt: 'b', meta: { chatId: 'group-b', groupName: 'B群' } });
  await generate({ kind: 'ambient', prompt: 'c', meta: { chatId: 'group-a', groupName: 'A群' } });

  assert.deepEqual(harness.calls.created, ['session-1', 'session-2']);
  assert.deepEqual(harness.calls.asked.map((call) => call.sessionId), ['session-1', 'session-2', 'session-1']);
});

test('memory consolidation still uses a one-shot archived session', async (t) => {
  const { dshHome } = await fixture(t);
  const harness = fakeHarness();
  const generate = createHarnessGroupBrainGenerator({
    harness,
    channel: 'wechat-personal',
    botId: 'xiaohao',
    dshHome,
    logger: { warn() {} },
  });

  await generate({ kind: 'consolidate', prompt: 'merge', meta: { chatId: 'group-1', groupName: '👫' } });
  await generate({ kind: 'consolidate', prompt: 'merge again', meta: { chatId: 'group-1', groupName: '👫' } });

  assert.deepEqual(harness.calls.created, ['session-1', 'session-2']);
  assert.deepEqual(harness.calls.archived, ['session-1', 'session-2']);
  assert.ok(harness.calls.renamed.every((entry) => entry.title.startsWith('记忆整理')));
  const records = await getGroupBrainSessionRegistry({ dshHome }).list();
  assert.deepEqual(records, []);
});

test('recreates the unified session when the old one no longer exists', async (t) => {
  const { dshHome } = await fixture(t);
  const harness = fakeHarness();
  let failFirstAsk = true;
  const originalAsk = harness.ask;
  harness.ask = async (sessionId, prompt) => {
    if (failFirstAsk && sessionId === 'session-1') {
      failFirstAsk = false;
      const error = new Error(`session.prompt: session ${sessionId} not found`);
      error.code = 'session-not-found';
      throw error;
    }
    return originalAsk(sessionId, prompt);
  };
  const generate = createHarnessGroupBrainGenerator({
    harness,
    channel: 'wechat-personal',
    botId: 'xiaohao',
    dshHome,
    logger: { warn() {} },
  });

  const reply = await generate({ kind: 'direct', prompt: 'hi', meta: { chatId: 'group-1', groupName: '👫' } });

  assert.equal(reply, 'reply:session-2:1');
  assert.deepEqual(harness.calls.created, ['session-1', 'session-2']);
  const records = await getGroupBrainSessionRegistry({ dshHome }).list();
  assert.equal(records.length, 1);
  assert.equal(records[0].sessionId, 'session-2');
});

test('persists the session mapping so a new generator instance keeps chatting in the same session', async (t) => {
  const { dshHome } = await fixture(t);
  const firstHarness = fakeHarness();
  const firstGenerate = createHarnessGroupBrainGenerator({
    harness: firstHarness,
    channel: 'wechat-personal',
    botId: 'xiaohao',
    dshHome,
    logger: { warn() {} },
  });
  await firstGenerate({ kind: 'direct', prompt: 'first', meta: { chatId: 'group-1', groupName: '👫' } });

  clearGroupBrainSessionRegistries();
  const path = groupBrainSessionsPath(dshHome);
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(Object.keys(parsed.sessions).length, 1);

  const secondHarness = fakeHarness();
  const secondGenerate = createHarnessGroupBrainGenerator({
    harness: secondHarness,
    channel: 'wechat-personal',
    botId: 'xiaohao',
    dshHome,
    logger: { warn() {} },
  });
  const reply = await secondGenerate({ kind: 'follow-up', prompt: 'second', meta: { chatId: 'group-1', groupName: '👫' } });

  assert.equal(reply, 'reply:session-1:1');
  assert.deepEqual(secondHarness.calls.created, []);
  assert.deepEqual(secondHarness.calls.asked.map((call) => call.sessionId), ['session-1']);
});

test('persistentGroupSessionTitle trims long group names', () => {
  assert.equal(persistentGroupSessionTitle('👫'), '群聊 · 👫');
  assert.equal(persistentGroupSessionTitle(''), '群聊会话');
  assert.ok(persistentGroupSessionTitle('x'.repeat(120)).length <= 80);
});
