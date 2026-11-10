import assert from 'node:assert/strict';
import test from 'node:test';

import { QqHarnessBridge } from '../src/channels/qq/qq-bridge.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

async function eventually(predicate, messageText = 'condition was not met') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(messageText);
}

function stateFixture(initialSessions = []) {
  const sessions = new Map(initialSessions);
  const seen = new Set();
  return {
    sessions,
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, sessionId) => sessions.set(key, sessionId),
      clearSession: async (key) => sessions.delete(key),
    },
  };
}

function groupMessage(overrides = {}) {
  return {
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId: 'member-1',
    senderName: '小明',
    senderIsBot: false,
    content: '今天好热啊',
    messageId: 'msg-1',
    groupOpenid: 'group-1',
    groupName: '小群',
    timestamp: '2026-11-10T02:00:00.000Z',
    mentions: [{ is_you: true, id: 'bot-openid' }],
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'msg-1' },
    ...overrides,
  };
}

function bridgeFixture({ groupBrain, asks = [] }) {
  const fixture = stateFixture([['group:group-1', 'session-group-1']]);
  const sent = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (target, text) => { sent.push({ target, text }); return { id: 'answer-1' }; },
    },
    ownerUserOpenid: '*',
    state: fixture.state,
    groupBrain,
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async (...args) => { asks.push(args); return '收到'; },
    },
  });
  return { bridge, fixture, sent };
}

test('QQ group ambient messages reach the group brain without calling the model', async () => {
  const observed = [];
  const asks = [];
  const groupBrain = {
    observe: async (event) => {
      observed.push(event);
      return { direct: false, recorded: true, duplicate: false, blocks: [] };
    },
  };
  const { bridge } = bridgeFixture({ groupBrain, asks });
  await bridge.accept(groupMessage({
    rawEventType: 'GROUP_MESSAGE_CREATE',
    messageId: 'ambient-1',
    content: '大家中午吃什么',
    mentions: [],
  }));
  await eventually(() => observed.length === 1);
  assert.equal(asks.length, 0);
  assert.equal(observed[0].chatId, 'group-1');
  assert.equal(observed[0].groupName, '小群');
  assert.equal(observed[0].mentionedBot, false);
  assert.equal(observed[0].text, '大家中午吃什么');
  assert.equal(typeof observed[0].at, 'number');
});

test('QQ addressed group messages append group brain blocks after the user text', async () => {
  const asks = [];
  const blocks = ['<dsh_im_direct_instruction>\n优先回应\n</dsh_im_direct_instruction>'];
  const groupBrain = {
    observe: async () => ({ direct: true, recorded: true, duplicate: false, blocks }),
  };
  const { bridge, sent } = bridgeFixture({ groupBrain, asks });
  await bridge.accept(groupMessage());
  await eventually(() => asks.length === 1);
  const prompt = asks[0][1];
  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /今天好热啊/);
  assert.match(prompt, /<dsh_im_direct_instruction>/);
  assert.ok(prompt.indexOf('今天好热啊') < prompt.indexOf('<dsh_im_direct_instruction>'));
  await eventually(() => sent.length === 1);
  assert.equal(sent[0].target.targetId, 'group-1');
});

test('QQ group brain failures never block message ingestion', async () => {
  const asks = [];
  const groupBrain = {
    observe: async () => { throw new Error('brain store unavailable'); },
  };
  const { bridge } = bridgeFixture({ groupBrain, asks });
  await bridge.accept(groupMessage({ messageId: 'resilient-1' }));
  await eventually(() => asks.length === 1);
  assert.equal(asks.length, 1);
});
