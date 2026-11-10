import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  WechatPersonalGroupBridge,
  formatTranscriptLine,
} from '../src/channels/wechat-personal/wechat-personal-brain.mjs';
import { offPeakSleepReplyText } from '../src/channels/shared/off-peak.mjs';

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

function fakeBrain({ direct = true, followUp = false } = {}) {
  const observed = [];
  return {
    observed,
    observe: async (event) => {
      observed.push(event);
      return {
        direct: direct && event.mentionedBot === true,
        followUp: followUp && event.mentionedBot !== true && event.kind !== 'bot',
        recorded: true,
        duplicate: false,
        blocks: event.mentionedBot ? ['<dsh_im_direct_instruction>回复对方</dsh_im_direct_instruction>', '<dsh_im_group_memory>记忆</dsh_im_group_memory>'] : [],
      };
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
    mergeWindowMs: 5,
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

test('a sleeping bridge replies with the fixed message instead of calling the model', async () => {
  const messages = [{
    id: 'msg-sleep',
    threadId: GROUP_ID,
    direction: 'incoming',
    senderId: SENDER_ID,
    body: '大肥鱼 在吗',
    createdAt: '2026-11-10T05:18:27+00:00',
    mentions: { self: true, userIds: [OWN_ID] },
  }];
  const client = fakeClient({
    messages,
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [{ id: SENDER_ID, displayName: 'Zach' }] }],
    members: [{ id: SENDER_ID, displayName: 'Zach' }, { id: OWN_ID, displayName: '大肥鱼版' }],
  });
  client.events = [{ cursor: '11', kind: 'message.committed', payload: { messageId: 'msg-sleep', direction: 'incoming' } }];
  const brain = fakeBrain({ direct: true });
  const prompts = [];
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain,
    generate: async (request) => { prompts.push(request.prompt); return '不应该调用模型。'; },
    resolvePersona: async () => ({ enabled: true, name: '大肥鱼（群聊版）', text: '你是大肥鱼。' }),
    isSleeping: async () => true,
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    mergeWindowMs: 5,
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await waitFor(() => client.sent.length === 1, 'the fixed sleep reply should be sent');
    assert.deepEqual(prompts, [], '高峰期不能调用模型');
    assert.equal(client.sent[0].text, offPeakSleepReplyText());
    assert.deepEqual(client.sent[0].mentions, { userIds: [SENDER_ID] });
    await waitFor(() => brain.observed.length === 2, 'the fixed reply should be recorded as a bot message');
    assert.equal(brain.observed[1].kind, 'bot');
    assert.equal(brain.observed[1].text, offPeakSleepReplyText());
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('a reused DSH session omits persona and memory block from later @ replies', async () => {
  const history = Array.from({ length: 15 }, (_, index) => ({
    id: `history-${index}`,
    threadId: GROUP_ID,
    direction: 'incoming',
    senderId: SENDER_ID,
    body: `旧的聊天 ${index}`,
    createdAt: `2026-11-10T05:${String(index).padStart(2, '0')}:00+00:00`,
    mentions: { self: false, userIds: [] },
  }));
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
    ...history,
  ];
  const client = fakeClient({
    messages,
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [{ id: SENDER_ID, displayName: 'Zach' }] }],
    members: [{ id: SENDER_ID, displayName: 'Zach' }],
  });
  client.events = [{ cursor: '9', kind: 'message.committed', payload: { messageId: 'msg-1', direction: 'incoming' } }];
  const brain = fakeBrain({ direct: true });
  const prompts = [];
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain,
    generate: async (request) => { prompts.push(request.prompt); return '在的在的。'; },
    resolvePersona: async () => ({ enabled: true, name: '大肥鱼（群聊版）', text: '你是大肥鱼。' }),
    sessionExists: async () => true,
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    mergeWindowMs: 5,
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await waitFor(() => client.sent.length === 1, 'reply should be sent');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].includes('你是大肥鱼。'), false, '复用会话时不再重复注入人设');
    assert.equal(prompts[0].includes('<dsh_im_group_memory>'), false, '复用会话时不再重复注入记忆块');
    assert.match(prompts[0], /<dsh_im_direct_instruction>/u);
    assert.match(prompts[0], /大肥鱼 在吗/u);
    const transcript = prompts[0].split('最近聊天：')[1].split('群成员')[0];
    const lines = transcript.trim().split('\n').filter((line) => line.startsWith('['));
    assert.ok(lines.length <= 8, `复用会话时最近聊天最多 8 条，实际 ${lines.length} 条`);
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
    mergeWindowMs: 5,
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
    mergeWindowMs: 5,
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
    mergeWindowMs: 5,
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


test('a follow-up window message replies naturally without an @ mention', async () => {
  const messages = [
    {
      id: 'msg-2',
      threadId: GROUP_ID,
      direction: 'incoming',
      senderId: SENDER_ID,
      body: '不过今天火锅真不错',
      createdAt: '2026-11-10T05:22:00+00:00',
      mentions: { self: false, userIds: [] },
    },
  ];
  const client = fakeClient({
    messages,
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [{ id: SENDER_ID, displayName: 'Zach' }] }],
    members: [{ id: SENDER_ID, displayName: 'Zach' }, { id: OWN_ID, displayName: '大肥鱼版' }],
  });
  client.events = [{ cursor: '8', kind: 'message.committed', payload: { messageId: 'msg-2', direction: 'incoming' } }];
  const brain = fakeBrain({ direct: true, followUp: true });
  const prompts = [];
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain,
    generate: async (request) => { prompts.push(request); return '是啊，那家店的毛肚特别脆。'; },
    resolvePersona: async () => ({ enabled: true, name: '大肥鱼（群聊版）', text: '你是大肥鱼。' }),
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    mergeWindowMs: 5,
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await waitFor(() => client.sent.length === 1, 'follow-up reply should be sent');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].kind, 'follow-up');
    assert.match(prompts[0].prompt, /你是大肥鱼/u);
    assert.match(prompts[0].prompt, /不过今天火锅真不错/u);
    assert.doesNotMatch(prompts[0].prompt, /<dsh_im_direct_instruction>/u);
    assert.equal(client.sent[0].text, '是啊，那家店的毛肚特别脆。');
    assert.equal(client.sent[0].mentions, undefined, 'follow-up 不 @ 人');
    assert.ok(brain.observed.length >= 2, 'user + bot message recorded');
    assert.equal(brain.observed.at(-1).kind, 'bot');
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('queues replies for different members and answers each in order', async () => {
  const SENDER_B = 'wxid_other';
  const messages = [
    { id: 'msg-a', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, body: '今天吃什么', createdAt: '2026-11-10T05:10:00+00:00', mentions: { self: false, userIds: [] } },
    { id: 'msg-b', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_B, body: '我想吃火锅', createdAt: '2026-11-10T05:10:05+00:00', mentions: { self: false, userIds: [] } },
  ];
  const client = fakeClient({
    messages,
    latestCursor: '0',
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [] }],
    members: [
      { id: SENDER_ID, displayName: 'Zach' },
      { id: SENDER_B, displayName: 'JYY' },
      { id: OWN_ID, displayName: '大肥鱼版' },
    ],
  });
  client.events = [
    { cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-a', direction: 'incoming' } },
    { cursor: '2', kind: 'message.committed', payload: { messageId: 'msg-b', direction: 'incoming' } },
  ];
  const prompts = [];
  let pending = 2;
  const home = await mkdtemp(join(tmpdir(), 'wp-queue-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain: fakeBrain({ direct: false, followUp: true }),
    generate: async (request) => {
      prompts.push(request.prompt);
      // 第一轮特意慢一点，确保第二条消息已经进入队列。
      await new Promise((resolve) => setTimeout(resolve, pending-- > 1 ? 40 : 5));
      return `回复第${prompts.length}条`;
    },
    resolvePersona: async () => ({ enabled: true, name: '大肥鱼（群聊版）', text: '你是大肥鱼。' }),
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    mergeWindowMs: 30,
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await waitFor(() => client.sent.length === 2, 'each member should get a reply');
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Zach 刚刚说/u);
    assert.match(prompts[0], /今天吃什么/u);
    assert.match(prompts[1], /JYY 刚刚说/u);
    assert.match(prompts[1], /我想吃火锅/u);
    assert.deepEqual(client.sent.map((entry) => entry.text), ['回复第1条', '回复第2条']);
    assert.equal(client.sent[0].mentions, undefined);
    assert.ok((await bridge.status()).pendingReplies.length === 0);
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('merges consecutive messages from the same member into one reply', async () => {
  const messages = [
    { id: 'msg-1', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, body: '第一句', createdAt: '2026-11-10T05:10:00+00:00', mentions: { self: false, userIds: [] } },
    { id: 'msg-2', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, body: '第二句', createdAt: '2026-11-10T05:10:01+00:00', mentions: { self: false, userIds: [] } },
  ];
  const client = fakeClient({
    messages,
    latestCursor: '0',
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [] }],
    members: [{ id: SENDER_ID, displayName: 'Zach' }, { id: OWN_ID, displayName: '大肥鱼版' }],
  });
  client.events = [
    { cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-1', direction: 'incoming' } },
    { cursor: '2', kind: 'message.committed', payload: { messageId: 'msg-2', direction: 'incoming' } },
  ];
  const prompts = [];
  const home = await mkdtemp(join(tmpdir(), 'wp-merge-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain: fakeBrain({ direct: false, followUp: true }),
    generate: async (request) => {
      prompts.push(request.prompt);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return '一起说';
    },
    resolvePersona: async () => ({ enabled: true, name: '大肥鱼（群聊版）', text: '你是大肥鱼。' }),
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    mergeWindowMs: 30,
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await waitFor(() => client.sent.length === 1, 'same member messages should merge');
    assert.equal(client.sent.length, 1);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /第一句/u);
    assert.match(prompts[0], /第二句/u);
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('waits for the configured merge window before replying to a follow-up', async () => {
  const messages = [
    { id: 'msg-window', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, body: '窗口测试', createdAt: '2026-11-10T05:10:00+00:00', mentions: { self: false, userIds: [] } },
  ];
  const client = fakeClient({
    messages,
    latestCursor: '0',
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [] }],
    members: [{ id: SENDER_ID, displayName: 'Zach' }, { id: OWN_ID, displayName: '大肥鱼版' }],
  });
  client.events = [{ cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-window', direction: 'incoming' } }];
  const home = await mkdtemp(join(tmpdir(), 'wp-window-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain: fakeBrain({ direct: false, followUp: true }),
    generate: async () => '窗口回复',
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    mergeWindowMs: 120,
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(client.sent.length, 0, 'follow-up reply must wait for the merge window');
    await waitFor(() => client.sent.length === 1, 'reply should arrive after the merge window');
    assert.equal(client.sent[0].text, '窗口回复');
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});
