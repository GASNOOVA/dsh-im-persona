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
    uploads: [],
    uploadMedia: async ({ name, bytes, mediaType }) => {
      client.uploads.push({ name, bytes, mediaType });
      return { id: `upload-${client.uploads.length}`, name, mediaType, byteLength: bytes?.byteLength ?? 0 };
    },
    voices: [],
    sendVoice: async (payload) => { client.voices.push(payload); return { id: `voice-${client.voices.length}`, state: 'accepted' }; },
    files: [],
    sendFile: async (payload) => { client.files.push(payload); return { id: `file-${client.files.length}`, state: 'accepted' }; },
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

test('an image message is downloaded and passed to the model as an image input', { skip: 'TODO(识图暂停)：识图能力暂缓' }, async () => {
  const messages = [{
    id: 'msg-img',
    threadId: GROUP_ID,
    direction: 'incoming',
    type: 3,
    senderId: SENDER_ID,
    body: null,
    createdAt: '2026-11-10T14:57:22+00:00',
    mentions: { self: true, userIds: [OWN_ID] },
  }];
  const client = fakeClient({
    messages,
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [{ id: SENDER_ID, displayName: 'Zach' }] }],
    members: [{ id: SENDER_ID, displayName: 'Zach' }, { id: OWN_ID, displayName: '大肥鱼版' }],
  });
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const downloads = [];
  client.downloadMessageImage = async (messageId) => {
    downloads.push(messageId);
    return { name: 'photo.png', bytes: imageBytes, mediaType: 'image/png' };
  };
  client.events = [{ cursor: '8', kind: 'message.committed', payload: { messageId: 'msg-img', direction: 'incoming' } }];
  const prompts = [];
  const generations = [];
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-img-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain: fakeBrain({ direct: true }),
    generate: async (request) => {
      generations.push(request);
      prompts.push(request.prompt);
      return '看到图啦。';
    },
    resolvePersona: async () => ({ enabled: true, name: '大肥鱼（群聊版）', text: '你是大肥鱼。' }),
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    mergeWindowMs: 5,
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    await waitFor(() => client.sent.length === 1, 'image reply should be sent');
    assert.deepEqual(downloads, ['msg-img']);
    assert.equal(generations.length, 1);
    assert.equal(generations[0].images.length, 1);
    assert.equal(generations[0].images[0].name, 'photo.png');
    assert.match(prompts[0], /\[图片\]/u);
    assert.match(prompts[0], /对方还发送了一张图片/u);
    assert.equal(client.sent[0].text, '看到图啦。');
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('a reply to the bot message opens the continuous conversation window', async () => {
  const messages = [{
    id: 'msg-quote',
    threadId: GROUP_ID,
    direction: 'incoming',
    senderId: SENDER_ID,
    body: '哈哈哈它在接我的梗',
    createdAt: '2026-11-10T05:30:00+00:00',
    mentions: { self: false, userIds: [] },
    quote: {
      direction: 'outgoing',
      senderId: OWN_ID,
      serverId: '1',
      embeddedText: '本鱼才没有偷吃白饭',
    },
  }];
  const client = fakeClient({
    messages,
    threads: [{ id: GROUP_ID, displayName: '👫', kind: 'group', avatarMembers: [{ id: SENDER_ID, displayName: 'Zach' }] }],
    members: [{ id: SENDER_ID, displayName: 'Zach' }, { id: OWN_ID, displayName: '大肥鱼版' }],
  });
  client.events = [{ cursor: '9', kind: 'message.committed', payload: { messageId: 'msg-quote', direction: 'incoming' } }];
  const brain = fakeBrain({ direct: true });
  const prompts = [];
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-'));
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain,
    generate: async (request) => { prompts.push(request); return '我也觉得！'; },
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
    assert.equal(brain.observed[0].mentionedBot, true);
    assert.equal(brain.observed[0].repliedToBot, true);
    assert.match(prompts[0].prompt, /刚刚回复了你的消息/u);
    assert.match(prompts[0].prompt, /哈哈哈它在接我的梗/u);
    const sent = client.sent[0];
    assert.equal(sent.threadId, GROUP_ID);
    assert.equal(sent.text, '我也觉得！');
    assert.deepEqual(sent.mentions, { userIds: [SENDER_ID] });
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('start preloads known groups so the status panel is not empty after a restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wp-bridge-'));
  const client = fakeClient({
    threads: [
      {
        id: GROUP_ID,
        displayName: '👫',
        kind: 'group',
        avatarMembers: [
          { id: 'wxid_a', displayName: 'Zach' },
          { id: 'wxid_b', displayName: 'JYY' },
          { id: OWN_ID, displayName: '大肥鱼版' },
        ],
      },
      { id: 'wxid_a', displayName: 'Zach', kind: 'direct' },
    ],
  });
  const bridge = new WechatPersonalGroupBridge({
    client,
    brain: fakeBrain(),
    generate: async () => 'hi',
    accountId: 'xiaohao',
    ownUserId: OWN_ID,
    statePath: join(home, 'cursor.json'),
    mergeWindowMs: 5,
    logger: { warn() {}, info() {}, error() {} },
  });
  try {
    await bridge.start();
    const status = await bridge.status();
    assert.equal(status.groups.length, 1);
    assert.equal(status.groups[0].chatId, GROUP_ID);
    assert.equal(status.groups[0].name, '👫');
    assert.equal(status.groups[0].memberCount, 3);
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});


test('a <dsh_im_voice> reply is synthesized and sent as a voice note', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-personal-voice-'));
  try {
    const messages = [
      { id: 'msg-voice', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '@大肥鱼 用语音说句话', createdAt: '2026-11-10T06:00:00+00:00', mentions: { all: false, self: true, state: 'known', userIds: [OWN_ID] } },
    ];
    const client = fakeClient({ messages });
    client.events = [{ id: '1', cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-voice', direction: 'incoming', threadId: GROUP_ID, type: 1 } }];
    const brain = fakeBrain();
    const synthesized = [];
    const bridge = new WechatPersonalGroupBridge({
      client,
      brain,
      generate: async () => '好呀，<dsh_im_voice>大家好，我是大肥鱼。</dsh_im_voice>来啦～',
      resolvePersona: async () => ({ enabled: true, name: '大肥鱼（群聊版）', text: '你是大肥鱼。' }),
      voice: {
        synthesize: async (text) => { synthesized.push(text); return new Uint8Array([0xff, 0xd8, 0x00]); },
        maxChars: 300,
        style: 'cute',
      },
      accountId: 'xiaohao',
      ownUserId: OWN_ID,
      statePath: join(home, 'cursor.json'),
      mergeWindowMs: 5,
      logger: { warn() {}, info() {}, error() {} },
    });
    try {
      await bridge.start();
      await waitFor(() => client.voices.length === 1, 'voice note should be sent');
      assert.deepEqual(synthesized, ['大家好，我是大肥鱼。']);
      assert.equal(client.uploads.length, 1);
      assert.equal(client.uploads[0].mediaType, 'audio/wav');
      assert.deepEqual(client.voices[0], { threadId: GROUP_ID, sourceId: 'upload-1' });
      assert.equal(client.sent.length, 1);
      assert.equal(client.sent[0].text, '好呀，来啦～');
      assert.ok(brain.observed.some((event) => event.kind === 'bot' && event.text.includes('[语音] 大家好，我是大肥鱼。')));
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('when voice synthesis fails the voice text falls back to a normal message', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-personal-voice-fallback-'));
  try {
    const messages = [
      { id: 'msg-voice-2', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '@大肥鱼 用语音说句话', createdAt: '2026-11-10T06:00:00+00:00', mentions: { all: false, self: true, state: 'known', userIds: [OWN_ID] } },
    ];
    const client = fakeClient({ messages });
    client.events = [{ id: '1', cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-voice-2', direction: 'incoming', threadId: GROUP_ID, type: 1 } }];
    const bridge = new WechatPersonalGroupBridge({
      client,
      brain: fakeBrain(),
      generate: async () => '<dsh_im_voice>大家好，我是大肥鱼。</dsh_im_voice>',
      resolvePersona: async () => null,
      voice: { synthesize: async () => { throw new Error('service down'); }, maxChars: 300, style: 'cute' },
      accountId: 'xiaohao',
      ownUserId: OWN_ID,
      statePath: join(home, 'cursor.json'),
      mergeWindowMs: 5,
      logger: { warn() {}, info() {}, error() {} },
    });
    try {
      await bridge.start();
      await waitFor(() => client.sent.length === 1, 'fallback text should be sent');
      assert.equal(client.voices.length, 0);
      assert.equal(client.sent[0].text, '大家好，我是大肥鱼。');
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('always voice mode turns every plain reply into a voice note', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-personal-voice-always-'));
  try {
    const messages = [
      { id: 'msg-always', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '@大肥鱼 在吗', createdAt: '2026-11-10T06:03:00+00:00', mentions: { all: false, self: true, state: 'known', userIds: [OWN_ID] } },
    ];
    const client = fakeClient({ messages });
    client.events = [{ id: '1', cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-always', direction: 'incoming', threadId: GROUP_ID, type: 1 } }];
    const synthesized = [];
    const brain = fakeBrain();
    const bridge = new WechatPersonalGroupBridge({
      client,
      brain,
      generate: async () => '在的在的，今天想聊点什么？',
      resolvePersona: async () => null,
      voice: {
        mode: 'always',
        synthesize: async (text) => { synthesized.push(text); return new Uint8Array([1, 2, 3]); },
        maxChars: 300,
        style: 'cute',
      },
      accountId: 'xiaohao',
      ownUserId: OWN_ID,
      statePath: join(home, 'cursor.json'),
      mergeWindowMs: 5,
      logger: { warn() {}, info() {}, error() {} },
    });
    try {
      await bridge.start();
      await waitFor(() => client.voices.length === 1, 'voice note should be sent in always mode');
      assert.deepEqual(synthesized, ['在的在的，今天想聊点什么？']);
      assert.equal(client.sent.length, 0);
      assert.ok(brain.observed.some((event) => event.kind === 'bot' && event.text.includes('[语音] 在的在的')));
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a quoted cover command downloads the Bilibili video and sends the cover file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-personal-cover-'));
  try {
    const coverText = '来翻唱一下这首歌 温柔一点';
    const messages = [
      { id: 'msg-cover', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 49, body: coverText, quote: { direction: 'incoming', senderId: SENDER_ID, serverId: '1', embeddedText: '[Link] 雨爱 https://b23.tv/qTRQCgV' }, createdAt: '2026-11-10T06:05:00+00:00', mentions: { all: false, self: false, state: 'known', userIds: [] } },
    ];
    const client = fakeClient({ messages });
    client.events = [{ id: '1', cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-cover', direction: 'incoming', threadId: GROUP_ID, type: 1 } }];
    const requests = [];
    const cover = {
      maxPromptChars: 300,
      client: {
        fetchCover: async (request) => {
          requests.push(request);
          return { bytes: new Uint8Array([1, 2, 3]), format: 'mp3', title: '测试歌曲', durationSeconds: 30, bvid: 'BV1xx411c7mD' };
        },
      },
    };
    const bridge = new WechatPersonalGroupBridge({
      client,
      brain: fakeBrain(),
      generate: async () => '不应调用模型',
      resolvePersona: async () => null,
      cover,
      accountId: 'xiaohao',
      ownUserId: OWN_ID,
      statePath: join(home, 'cursor.json'),
      mergeWindowMs: 5,
      logger: { warn() {}, info() {}, error() {} },
    });
    try {
      await bridge.start();
      await waitFor(() => client.files.length === 1, 'cover file should be sent');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://b23.tv/qTRQCgV');
      assert.equal(requests[0].mix, false);
      assert.match(requests[0].prompt, /温柔一点/u);
      assert.equal(client.uploads.length, 1);
      assert.equal(client.uploads[0].mediaType, 'audio/mpeg');
      assert.deepEqual(client.files[0], { threadId: GROUP_ID, sourceId: 'upload-1' });
      assert.ok(!client.sent.some((item) => item.text.includes('收到翻唱请求')), 'accepting a cover command must stay silent');
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test('a cover command can use the most recent Bilibili link in the chat', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-personal-cover-recent-'));
  try {
    const messages = [
      { id: 'msg-link', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: 'https://www.bilibili.com/video/BV1xx411c7mD', createdAt: '2026-11-10T06:04:00+00:00', mentions: { all: false, self: false, state: 'known', userIds: [] } },
      { id: 'msg-cover', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '给我翻唱一下 温柔一点', createdAt: '2026-11-10T06:05:00+00:00', mentions: { all: false, self: false, state: 'known', userIds: [] } },
    ];
    const client = fakeClient({ messages });
    client.events = [
      { id: '1', cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-link', direction: 'incoming' } },
      { id: '2', cursor: '2', kind: 'message.committed', payload: { messageId: 'msg-cover', direction: 'incoming' } },
    ];
    const requests = [];
    const cover = {
      maxPromptChars: 300,
      client: {
        fetchCover: async (request) => {
          requests.push(request);
          return { bytes: new Uint8Array([1, 2, 3]), format: 'mp3', title: '测试歌曲', durationSeconds: 30, bvid: 'BV1xx411c7mD' };
        },
      },
    };
    const bridge = new WechatPersonalGroupBridge({
      client,
      brain: fakeBrain(),
      generate: async () => '不应调用模型',
      resolvePersona: async () => null,
      cover,
      accountId: 'xiaohao',
      ownUserId: OWN_ID,
      statePath: join(home, 'cursor.json'),
      mergeWindowMs: 5,
      logger: { warn() {}, info() {}, error() {} },
    });
    try {
      await bridge.start();
      await waitFor(() => client.files.length === 1, 'cover file should be sent for the remembered link');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://www.bilibili.com/video/BV1xx411c7mD');
      assert.equal(requests[0].mix, false);
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the #语音模式 injected command toggles voice replies for the chat', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-personal-voice-toggle-'));
  try {
    const messages = [
      { id: 'msg-control', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '#语音模式 关', createdAt: '2026-11-10T06:10:00+00:00', mentions: { all: false, self: false, state: 'known', userIds: [] } },
      { id: 'msg-after', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '@大肥鱼 在吗', createdAt: '2026-11-10T06:11:00+00:00', mentions: { all: false, self: true, state: 'known', userIds: [OWN_ID] } },
    ];
    const client = fakeClient({ messages });
    client.events = [
      { id: '1', cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-control', direction: 'incoming', threadId: GROUP_ID, type: 1 } },
      { id: '2', cursor: '2', kind: 'message.committed', payload: { messageId: 'msg-after', direction: 'incoming', threadId: GROUP_ID, type: 1 } },
    ];
    const synthesized = [];
    const bridge = new WechatPersonalGroupBridge({
      client,
      brain: fakeBrain(),
      generate: async () => '在的在的。',
      resolvePersona: async () => null,
      voice: {
        mode: 'always',
        synthesize: async (text) => { synthesized.push(text); return new Uint8Array([1]); },
        maxChars: 300,
        style: 'cute',
        isAvailable: async () => true,
      },
      accountId: 'xiaohao',
      ownUserId: OWN_ID,
      statePath: join(home, 'cursor.json'),
      mergeWindowMs: 5,
      logger: { warn() {}, info() {}, error() {} },
    });
    try {
      await bridge.start();
      await waitFor(() => client.sent.length >= 2, 'control ack and text reply should be sent');
      assert.equal(synthesized.length, 0);
      assert.equal(client.voices.length, 0);
      assert.ok(client.sent.some((item) => item.text.includes('语音模式已关闭')));
      assert.ok(client.sent.some((item) => item.text === '在的在的。'));
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the #闭嘴 injected command pauses follow-ups until the next @ mention', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-personal-mute-'));
  try {
    const messages = [
      { id: 'msg-mute', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '#闭嘴', createdAt: '2026-11-10T06:20:00+00:00', mentions: { all: false, self: false, state: 'known', userIds: [] } },
      { id: 'msg-quiet-1', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '继续聊呀', createdAt: '2026-11-10T06:21:00+00:00', mentions: { all: false, self: false, state: 'known', userIds: [] } },
      { id: 'msg-wake', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '@大肥鱼 回来啦', createdAt: '2026-11-10T06:22:00+00:00', mentions: { all: false, self: true, state: 'known', userIds: [OWN_ID] } },
      { id: 'msg-quiet-2', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '再说一句', createdAt: '2026-11-10T06:23:00+00:00', mentions: { all: false, self: false, state: 'known', userIds: [] } },
    ];
    const client = fakeClient({ messages });
    client.events = messages.map((message, index) => ({
      id: String(index + 1),
      cursor: String(index + 1),
      kind: 'message.committed',
      payload: { messageId: message.id, direction: 'incoming', threadId: GROUP_ID, type: 1 },
    }));
    const prompts = [];
    const bridge = new WechatPersonalGroupBridge({
      client,
      brain: fakeBrain({ direct: true, followUp: true }),
      generate: async (request) => { prompts.push(request.prompt); return '好呀。'; },
      resolvePersona: async () => null,
      accountId: 'xiaohao',
      ownUserId: OWN_ID,
      statePath: join(home, 'cursor.json'),
      mergeWindowMs: 5,
      logger: { warn() {}, info() {}, error() {} },
    });
    try {
      await bridge.start();
      await waitFor(() => client.sent.filter((item) => item.text === '好呀。').length === 2, 'direct reply and follow-up reply should be sent');
      assert.equal(prompts.length, 2);
      assert.ok(client.sent.some((item) => item.text.includes('不自动接话')));
      assert.ok(!prompts.some((prompt) => prompt.includes('刚刚说：\n继续聊呀')));
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('voice replies fall back to text while a cover job is running', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-personal-cover-busy-'));
  try {
    const messages = [
      { id: 'msg-cover-busy', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '翻唱 https://b23.tv/qTRQCgV 温柔一点', createdAt: '2026-11-10T06:30:00+00:00', mentions: { all: false, self: false, state: 'known', userIds: [] } },
      { id: 'msg-ask-busy', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '@大肥鱼 在吗', createdAt: '2026-11-10T06:31:00+00:00', mentions: { all: false, self: true, state: 'known', userIds: [OWN_ID] } },
    ];
    const client = fakeClient({ messages });
    client.events = [
      { id: '1', cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-cover-busy', direction: 'incoming', threadId: GROUP_ID, type: 1 } },
      { id: '2', cursor: '2', kind: 'message.committed', payload: { messageId: 'msg-ask-busy', direction: 'incoming', threadId: GROUP_ID, type: 1 } },
    ];
    let releaseCover = null;
    const pendingCover = new Promise((resolve) => { releaseCover = resolve; });
    const requests = [];
    const cover = {
      maxPromptChars: 300,
      client: {
        fetchCover: async (request) => {
          requests.push(request);
          await pendingCover;
          return { bytes: new Uint8Array([1, 2, 3]), format: 'mp3', title: '测试歌曲', durationSeconds: 30, bvid: 'BV1xx411c7mD' };
        },
      },
    };
    const bridge = new WechatPersonalGroupBridge({
      client,
      brain: fakeBrain(),
      generate: async () => '在的在的。',
      resolvePersona: async () => null,
      voice: {
        mode: 'always',
        synthesize: async () => { throw new Error('should not be called'); },
        maxChars: 300,
        style: 'cute',
        isAvailable: async () => true,
      },
      cover,
      accountId: 'xiaohao',
      ownUserId: OWN_ID,
      statePath: join(home, 'cursor.json'),
      mergeWindowMs: 5,
      logger: { warn() {}, info() {}, error() {} },
    });
    try {
      await bridge.start();
      await waitFor(() => requests.length === 1, 'cover job should start');
      await waitFor(() => client.sent.some((item) => item.text === '在的在的。'), 'reply while cover runs should be text');
      assert.equal(client.voices.length, 0);
      releaseCover();
      await waitFor(() => client.files.length === 1, 'cover file should be sent');
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('voice replies fall back to text when the remote voice service is unavailable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-personal-voice-down-'));
  try {
    const messages = [
      { id: 'msg-down', threadId: GROUP_ID, direction: 'incoming', senderId: SENDER_ID, senderName: 'Zach', type: 1, body: '@大肥鱼 在吗', createdAt: '2026-11-10T06:40:00+00:00', mentions: { all: false, self: true, state: 'known', userIds: [OWN_ID] } },
    ];
    const client = fakeClient({ messages });
    client.events = [{ id: '1', cursor: '1', kind: 'message.committed', payload: { messageId: 'msg-down', direction: 'incoming', threadId: GROUP_ID, type: 1 } }];
    let synthesized = 0;
    const bridge = new WechatPersonalGroupBridge({
      client,
      brain: fakeBrain(),
      generate: async () => '在的在的。',
      resolvePersona: async () => null,
      voice: {
        mode: 'always',
        synthesize: async () => { synthesized += 1; return new Uint8Array([1]); },
        maxChars: 300,
        style: 'cute',
        isAvailable: async () => false,
      },
      accountId: 'xiaohao',
      ownUserId: OWN_ID,
      statePath: join(home, 'cursor.json'),
      mergeWindowMs: 5,
      logger: { warn() {}, info() {}, error() {} },
    });
    try {
      await bridge.start();
      await waitFor(() => client.sent.length === 1, 'text reply should be sent');
      assert.equal(synthesized, 0);
      assert.equal(client.voices.length, 0);
      assert.equal(client.sent[0].text, '在的在的。');
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
