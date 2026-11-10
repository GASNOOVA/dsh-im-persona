import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentWechatClient,
  AgentWechatError,
  normalizeAgentWechatDaemonUrl,
} from '../src/channels/wechat-personal/agent-wechat-client.mjs';

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clientWith(handler, overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  const client = new AgentWechatClient({
    baseUrl: 'http://127.0.0.1:16174',
    token: 'secret-token',
    accountId: 'xiaohao',
    fetchImpl,
    ...overrides,
  });
  return { client, calls };
}

test('normalizeAgentWechatDaemonUrl accepts http(s) and strips trailing slash', () => {
  assert.equal(normalizeAgentWechatDaemonUrl('http://127.0.0.1:16174/'), 'http://127.0.0.1:16174');
  assert.equal(normalizeAgentWechatDaemonUrl('https://example.com/base/'), 'https://example.com/base');
  assert.throws(() => normalizeAgentWechatDaemonUrl('ftp://example.com'), /http or https/);
  assert.throws(() => normalizeAgentWechatDaemonUrl(''), /required/);
});

test('client sends bearer auth and unwraps list items', async () => {
  const { client, calls } = clientWith((url) => {
    if (url.endsWith('/threads?limit=2')) {
      return jsonResponse({ items: [{ id: '19129875381@chatroom', displayName: '👫', kind: 'group' }] });
    }
    if (url.endsWith('/groups/g1/members?limit=10')) {
      return jsonResponse({ items: [{ id: 'wxid_a', displayName: 'Zach' }] });
    }
    if (url.includes('/messages/msg-1')) {
      return jsonResponse({ message: { id: 'msg-1', body: '你好', threadId: 'g1' } });
    }
    return jsonResponse({});
  });
  const threads = await client.listThreads({ limit: 2 });
  assert.deepEqual(threads, [{ id: '19129875381@chatroom', displayName: '👫', kind: 'group' }]);
  const members = await client.listMembers('g1', { limit: 10 });
  assert.equal(members[0].displayName, 'Zach');
  const message = await client.getMessage('msg-1');
  assert.equal(message.body, '你好');
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer secret-token');
  }
});

test('client sends text with an idempotency key and optional mentions', async () => {
  const { client, calls } = clientWith(() => jsonResponse({ id: 'send-1', state: 'accepted' }));
  const result = await client.sendText({
    threadId: '19129875381@chatroom',
    text: '收到',
    mentions: { userIds: ['wxid_a'] },
    idempotencyKey: 'dsh-test-1',
  });
  assert.equal(result.id, 'send-1');
  const call = calls[0];
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Idempotency-Key'], 'dsh-test-1');
  const body = JSON.parse(call.options.body);
  assert.equal(body.threadId, '19129875381@chatroom');
  assert.equal(body.text, '收到');
  assert.deepEqual(body.mentions, { userIds: ['wxid_a'] });
});

test('client surfaces daemon error codes', async () => {
  const { client } = clientWith(() => jsonResponse({ error: { code: 'not_authenticated', message: 'login required' } }, { status: 401 }));
  await assert.rejects(() => client.listAccounts(), (error) => {
    assert.ok(error instanceof AgentWechatError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'not_authenticated');
    return true;
  });
});

test('streamEvents parses SSE frames and yields normalized events', async () => {
  const sse = [
    ': connected',
    '',
    'id: 279',
    'data: {"cursor":"279","kind":"message.committed","data":{"messageId":"msg-1","direction":"incoming"}}',
    '',
    'id: 280',
    'data: {"cursor":"280","kind":"send.updated","data":{"id":"send-1"}}',
    '',
    '',
  ].join('\n');
  const { client } = clientWith(() => new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }));
  const seen = [];
  for await (const event of client.streamEvents({ after: '278' })) seen.push(event);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].cursor, '279');
  assert.equal(seen[0].kind, 'message.committed');
  assert.deepEqual(seen[0].payload, { messageId: 'msg-1', direction: 'incoming' });
  assert.equal(seen[1].kind, 'send.updated');
});
