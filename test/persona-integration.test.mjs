// 人设接入的链路级测试：注入块拆分、标题剥离、/steer 注入与微信/QQ 桥接注入。
//
// 这些测试不启动真实 Harness：桥接用最小 state/harness stub 捕获交给模型的
// prompt 内容，因此直接验证「渠道侧只依赖已解析人设接口」后的接线行为。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PERSONA_TAG,
  injectPersonaContent,
  personaBlock,
  resolvePersonaInjection,
} from '../src/channels/shared/persona.mjs';
import {
  splitLeadingInjectedContext,
  rewriteInjectedContextMessages,
} from '../src/channels/shared/injected-context.mjs';
import {
  captureContextEnhancementSource,
  INJECTED_CONTEXT_TAGS,
} from '../src/channels/shared/context-enhancement.mjs';
import { initialSessionTitle } from '../src/channels/shared/session-title.mjs';
import { steerMessage } from '../src/channels/shared/control-command.mjs';
import { WeixinHarnessBridge } from '../src/channels/weixin/weixin-bridge.mjs';
import { QqHarnessBridge } from '../src/channels/qq/qq-bridge.mjs';

const RESOLVED = Object.freeze({ enabled: true, name: '大肥鱼', text: '你是大肥鱼，回答要简洁。' });
const INLINE = Object.freeze({
  enabled: true, name: '小助手', tone: '温和', instructions: '不要编造事实。',
});

function personaWith(value = RESOLVED) {
  return { botId: 'bot_1', getPersona: () => value };
}

function prompt(text, options = {}) {
  return {
    id: options.id ?? 'prompt-1',
    role: 'user',
    source: { kind: 'user', rpcId: 'rpc-1' },
    content: [{ type: 'text', text }],
  };
}

async function eventually(predicate, messageText = 'condition was not met') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(messageText);
}

// ---------------------------------------------------------------------------
// Host agent/pre-step 拆分：人设块 → 独立 instructions 行
// ---------------------------------------------------------------------------

test('拆分端把恰好成框的人设块移出用户消息，作为独立 instructions 行', () => {
  const block = personaBlock(RESOLVED);
  const messages = [prompt(`${block}\n\n用户正文`)];
  const rewritten = rewriteInjectedContextMessages(messages, { newId: () => 'ctx-1' });
  assert.equal(Array.isArray(rewritten), true);
  assert.equal(rewritten.length, 2);
  assert.deepEqual(rewritten[0], {
    id: 'ctx-1',
    role: 'user',
    content: [{ type: 'text', text: block }],
    source: { kind: 'plugin:dsh-im', form: 'instructions' },
  });
  assert.deepEqual(rewritten[1].content, [{ type: 'text', text: '用户正文' }]);

  // 直接调用解析器：value 不带框定换行，供未来系统提示词去重使用。
  const split = splitLeadingInjectedContext(`${block}\n\n用户正文`);
  assert.deepEqual(split.blocks.map((entry) => entry.form), ['instructions']);
  assert.equal(split.blocks[0].value, RESOLVED.text);
  assert.equal(split.rest, '用户正文');
});

test('缺少框定换行的同名标签保持普通用户文本', () => {
  const bare = `${PERSONA_TAG.open}用户自己写的内容${PERSONA_TAG.close}`;
  assert.equal(splitLeadingInjectedContext(bare), null);
  assert.equal(rewriteInjectedContextMessages([prompt(bare)], { newId: () => 'ctx-1' }), null);
  // 只有一侧换行也不认。
  const halfFramed = `${PERSONA_TAG.open}\n内容${PERSONA_TAG.close}`;
  assert.equal(splitLeadingInjectedContext(halfFramed), null);
});

test('人设块与来源/增强块共存时按生产者顺序拆分，位置正确', () => {
  const block = personaBlock(RESOLVED);
  const source = `${INJECTED_CONTEXT_TAGS.sourceOpen}{"channel":"weixin","senderId":"wxid_1"}${INJECTED_CONTEXT_TAGS.sourceClose}`;
  const guidance = `${INJECTED_CONTEXT_TAGS.guidanceOpen}\n按来源字段理解消息\n${INJECTED_CONTEXT_TAGS.guidanceClose}`;
  const content = [block, source, guidance, '用户正文'].join('\n\n');
  const rewritten = rewriteInjectedContextMessages([prompt(content)], { newId: (() => {
    let n = 0;
    return () => `ctx-${n += 1}`;
  })() });
  assert.equal(rewritten.length, 4);
  // persona 是 before：出现在用户消息之前；source/guidance 是 after：出现在之后。
  assert.deepEqual(rewritten[0].source, { kind: 'plugin:dsh-im', form: 'instructions' });
  assert.deepEqual(rewritten[1].content, [{ type: 'text', text: '用户正文' }]);
  assert.equal(rewritten[2].source.kind, 'plugin:dsh-im');
  assert.equal(rewritten[2].source.form, 'notice');
  assert.deepEqual(rewritten[3].source, { kind: 'plugin:dsh-im', form: 'instructions' });

  // 只开人设、消息为独立 text part 的媒体消息同样可拆。
  const parts = injectPersonaContent([{ type: 'image', path: 'x.png' }], RESOLVED);
  const media = [{
    id: 'm-media', role: 'user', source: { kind: 'user', rpcId: 'rpc-media' }, content: parts,
  }];
  const mediaRewritten = rewriteInjectedContextMessages(media, { newId: () => 'ctx-media' });
  assert.deepEqual(mediaRewritten[0].content, [{ type: 'text', text: personaBlock(RESOLVED) }]);
  assert.deepEqual(mediaRewritten[1].content, [{ type: 'image', path: 'x.png' }]);
});

test('人设正文里被转义的结束标签不会提前截断块', () => {
  const hostile = {
    enabled: true,
    name: 'A',
    text: `正文里有 ${PERSONA_TAG.close} 字样`,
  };
  const block = personaBlock(hostile);
  const split = splitLeadingInjectedContext(`${block}\n\n用户正文`);
  assert.equal(split.blocks.length, 1);
  assert.equal(split.rest, '用户正文');
  assert.equal(split.blocks[0].value.includes(PERSONA_TAG.close), false);
});

// ---------------------------------------------------------------------------
// 会话标题：前缀剥离
// ---------------------------------------------------------------------------

test('会话标题不会取到人设块，媒体消息回退到文件名', () => {
  const block = personaBlock(RESOLVED);
  assert.equal(initialSessionTitle({ text: '', content: `${block}\n\n` }), null);
  assert.equal(
    initialSessionTitle({ text: '', content: `${block}\n\n`, files: [{ name: 'photo.png' }] }),
    'photo.png',
  );
  // 有用户正文时，标题在剥离人设/来源块后取正文。
  assert.equal(
    initialSessionTitle({ text: '', content: `${block}\n\n只保留正文` }),
    '只保留正文',
  );
});

// ---------------------------------------------------------------------------
// /steer：补充指令带人设
// ---------------------------------------------------------------------------

async function steerInto(options) {
  let steering;
  const harness = {
    workspaceSession: () => ({
      steerActiveTurn: async (text) => { steering = text; return true; },
    }),
  };
  const state = { sessionFor: () => 'session-1' };
  const result = await steerMessage('请纠正一下', harness, state, 'c2c:owner', options);
  return { result, steering };
}

test('/steer 的补充指令注入已解析人设，未启用时不注入', async () => {
  const on = await steerInto({ persona: resolvePersonaInjection(RESOLVED) });
  assert.equal(on.result, true);
  assert.equal(on.steering, `${personaBlock(RESOLVED)}\n\n请纠正一下`);

  const off = await steerInto({ persona: null });
  assert.equal(off.steering, '请纠正一下');
});

test('/steer 同时带上下文增强时前缀顺序为人设 → 来源 → 增强提示词 → 正文', async () => {
  const enhancement = captureContextEnhancementSource(
    {
      botId: 'bot_1',
      getSettings: () => ({
        group: { enabled: false, fields: [], guidance: '' },
        direct: { enabled: true, fields: ['senderId'], guidance: '按来源理解' },
      }),
    },
    'direct',
    () => ({ channel: 'qq', senderId: 'user-1' }),
  );
  const { steering } = await steerInto({ enhancement, persona: resolvePersonaInjection(INLINE) });
  const personaAt = steering.indexOf(PERSONA_TAG.open);
  const sourceAt = steering.indexOf(INJECTED_CONTEXT_TAGS.sourceOpen);
  const guidanceAt = steering.indexOf(INJECTED_CONTEXT_TAGS.guidanceOpen);
  const bodyAt = steering.indexOf('请纠正一下');
  assert.ok(personaAt >= 0 && sourceAt > personaAt && guidanceAt > sourceAt && bodyAt > guidanceAt);
});

// ---------------------------------------------------------------------------
// 渠道桥接：prompt 组装带人设块；命令不进入 Harness
// ---------------------------------------------------------------------------

function weixinStateFixture() {
  const sessions = new Map([['p2p:owner-user', 'session-1']]);
  const seen = new Set();
  return {
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, sessionId) => sessions.set(key, sessionId),
      clearSession: async (key) => sessions.delete(key),
    },
  };
}

function weixinMessage(id, text) {
  return {
    message_id: id,
    message_type: 1,
    from_user_id: 'owner-user',
    context_token: `context-${id}`,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function qqStateFixture() {
  const sessions = new Map([['c2c:owner-openid', 'session-1']]);
  const seen = new Set();
  return {
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, sessionId) => sessions.set(key, sessionId),
      clearSession: async (key) => sessions.delete(key),
    },
  };
}

function qqMessage(overrides = {}) {
  return {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'owner-openid',
    senderIsBot: false,
    content: '请回答',
    messageId: 'qq-msg-1',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'qq-msg-1' },
    ...overrides,
  };
}

test('微信桥接把已解析人设块拼到用户正文之前，关闭时原文不变', async () => {
  let captured;
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async () => ({ messageId: 'answer-1' }) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { captured = content; return '已处理'; },
    },
    state: weixinStateFixture().state,
    persona: personaWith(),
  });
  await bridge.accept(weixinMessage('weixin-persona-1', '你好'));
  await eventually(() => captured !== undefined);
  assert.equal(typeof captured, 'string');
  assert.equal(captured, injectPersonaContent('你好', RESOLVED));

  const disabled = new WeixinHarnessBridge({
    api: { sendText: async () => ({ messageId: 'answer-2' }) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { captured = content; return '已处理'; },
    },
    state: weixinStateFixture().state,
    persona: { botId: 'bot_1', getPersona: () => null },
  });
  captured = undefined;
  await disabled.accept(weixinMessage('weixin-persona-2', '你好'));
  await eventually(() => captured !== undefined);
  assert.equal(captured, '你好');
});

test('QQ 桥接把已解析人设块拼到用户正文之前，关闭时原文不变', async () => {
  let captured;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async () => ({ id: 'qq-answer-1' }) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { captured = content; return '已处理'; },
    },
    state: qqStateFixture().state,
    persona: personaWith(),
  });
  await bridge.accept(qqMessage());
  await eventually(() => captured !== undefined);
  assert.equal(Array.isArray(captured) || typeof captured === 'string', true);
  assert.equal(captured, injectPersonaContent('请回答', RESOLVED));

  captured = undefined;
  const disabled = new QqHarnessBridge({
    bot: { sendText: async () => ({ id: 'qq-answer-2' }) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { captured = content; return '已处理'; },
    },
    state: qqStateFixture().state,
    persona: { botId: 'bot_1', getPersona: () => null },
  });
  await disabled.accept(qqMessage({ messageId: 'qq-msg-2' }));
  await eventually(() => captured !== undefined);
  assert.equal(captured, '请回答');
});

test('本地命令不注入人设、也不进入 Harness', async () => {
  let asked = 0;
  const sent = [];
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (_target, text) => { sent.push(text); return { messageId: 'answer' }; } },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => { asked += 1; return 'unexpected'; },
    },
    state: weixinStateFixture().state,
    persona: personaWith(),
  });
  await bridge.accept(weixinMessage('weixin-command-1', '/status'));
  assert.equal(asked, 0);
  assert.equal(sent.length > 0, true);
  // 命令只在本地处理：不进入 Harness，任何回执里也看不到人设块。
  assert.equal(sent.some((entry) => JSON.stringify(entry ?? '').includes(PERSONA_TAG.open)), false);
});
