import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  WechatPersonalGroupBridge,
  formatTranscriptLine,
} from '../src/channels/wechat-personal/wechat-personal-brain.mjs';

const GROUP_ID = '19129875381@chatroom';
const OWN_ID = 'wxid_me';
const SENDER_ID = 'wxid_friend';

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function fakeClient({ messages = [], threads = [], members = [], latestCursor = '285' } = {}) {
  const sent = [];
  const askedAfter = [];
  const client = {
    askedAfter,
    latestEventCursor: async () => latestCursor,
    sent,
    sendText: async (payload) => { sent.push(payload); return { id: `send-${sent.length}`, state: 'accepted' }; },
    listThreads: async () => threads,
    listMembers: async () => members,
    listMessages: async () => messages,
    getMessage: async (id) => messages.find((message) => message.id === id) ?? null,
    async *streamEvents({ after, signal } = {}) {
      askedAfter.push(after ?? null);
      for (const event of client.events) yield event;
      if (signal?.aborted) return;
      // 保持挂起，模拟真实 SSE；测试结束由 abort 信号唤醒。
      await new Promise((resolve) => { signal?.addEventListener('abort', resolve, { once: true }); });
    },
    events: [],
  };
  return client;
}

function fakeBrain({ direct = true } = {}) {
  const observed = [];
  return {
    observed,
    observe: async (event) => {
      observed.push(event);
      return { direct: direct && event.mentionedBot === true, recorded: true, duplicate: false, blocks: event.mentionedBot ? ['<dsh_im_direct_instruction>回复对方</dsh_im_direct_instruction>', '<dsh_im_group_memory>记忆</dsh_im_group_memory>'] : [] };
    },
  };
}

test('formatTranscriptLine renders clock, sender and body', () => {
  const line = formatTranscriptLine(
    { createdAt: '2026-11-10T05:18:27+00:00', senderId: 'wxid_a', body: '你好' },
    (id) => (id === 'wxid_a' ? 'Zach' : id),
  );
  assert.match(line, /^\[\d{2}:\d{2}\] Zach：你好$/u);
});

test('an @ message becomes a direct reply with mentions', async () => {
  const messages = [
    {
      id: 'msg-1',
      threadId: GROUP_ID,
      direction: 'incoming',
      senderId: SENDER_ID,
      body: '大肥鱼 在吗',
      createdAt: '2026-11-10T05:18:27+00:00',
      mentions: { self: true, userIds: [OWN_ID] },
    },
    {
      id: 'msg-0',
      threadId: GROUP_ID,
      direction: 'incoming',
      senderId: SENDER_ID,
      body: '刚才那事你怎么看',
      createdAt: '2026-11-10T05:10:00+00:00',
      mentions: { self: false, userIds: [] },
    },
  ];
  const client = fakeClient({
    messages,
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [{ id: SENDER_ID, displayName: 'Zach' }] }],
    members: [{ id: SENDER_ID, displayName: 'Zach' }, { id: OWN_ID, displayName: '大肥鱼版' }],
  });
  client.events = [{ cursor: '7', kind: 'message.committed', payload: { messageId: 'msg-1', direction: 'incoming' } }];
  const brain = fakeBrain({ direct: true });
  const prompts = [];
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain,
    generate: async (request) => { prompts.push(request.prompt); return '收到，我来啦。'; },
    resolvePersona: async () => ({ enabled: true, name: '大肥鱼（群聊版）', text: '你是大肥鱼。' }),
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await waitFor(() => client.sent.length === 1, 'reply should be sent');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /你是大肥鱼/u);
    assert.match(prompts[0], /最近聊天/u);
    assert.match(prompts[0], /刚才那事你怎么看/u);
    assert.match(prompts[0], /大肥鱼 在吗/u);
    assert.match(prompts[0], /<dsh_im_direct_instruction>/u);
    const sent = client.sent[0];
    assert.equal(sent.threadId, GROUP_ID);
    assert.equal(sent.text, '收到，我来啦。');
    assert.deepEqual(sent.mentions, { userIds: [SENDER_ID] });
    await waitFor(() => brain.observed.length === 2, 'bot message should be recorded');
    assert.equal(brain.observed[0].kind, 'group');
    assert.equal(brain.observed[0].mentionedBot, true);
    assert.equal(brain.observed[1].kind, 'bot');
    assert.equal(brain.observed[1].text, '收到，我来啦。');
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('an unaddressed group message is recorded but never answered', async () => {
  const messages = [{
    id: 'msg-2',
    threadId: GROUP_ID,
    direction: 'incoming',
    senderId: SENDER_ID,
    body: '今天好热',
    createdAt: '2026-11-10T05:20:00+00:00',
    mentions: { self: false, userIds: [] },
  }];
  const client = fakeClient({
    messages,
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [] }],
    members: [{ id: SENDER_ID, displayName: 'Zach' }],
  });
  client.events = [{ cursor: '8', kind: 'message.committed', payload: { messageId: 'msg-2', direction: 'incoming' } }];
  const brain = fakeBrain({ direct: false });
  const prompts = [];
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain,
    generate: async (request) => prompts.push(request),
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await waitFor(() => brain.observed.length === 1, 'message should be observed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(prompts.length, 0);
    assert.equal(client.sent.length, 0);
    assert.equal(brain.observed[0].mentionedBot, false);
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('sendAmbient sends text and records a bot message', async () => {
  const client = fakeClient();
  const brain = fakeBrain({ direct: false });
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain,
    generate: async () => '不应该调用',
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    const ok = await bridge.sendAmbient({ chatId: GROUP_ID, text: '这句话是自动接的', groupName: '👫' });
    assert.equal(ok, true);
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].threadId, GROUP_ID);
    assert.equal(brain.observed.length, 1);
    assert.equal(brain.observed[0].kind, 'bot');
    assert.equal(await bridge.sendAmbient({ chatId: 'not-a-group', text: 'x' }), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('first start begins at the daemon cursor instead of replaying history', async () => {
  const client = fakeClient();
  const brain = fakeBrain({ direct: false });
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain,
    generate: async () => 'x',
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await waitFor(() => client.askedAfter.length === 1, 'stream should be opened');
    assert.equal(client.askedAfter[0], '285');
    assert.equal(brain.observed.length, 0);
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});
