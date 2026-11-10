import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FeiyuVoiceClient,
  FeiyuVoiceError,
  normalizeFeiyuServiceUrl,
  normalizeFeiyuStyle,
} from '../src/channels/wechat-personal/feiyu-voice-client.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function audioResponse(bytes) {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length) } });
}

test('normalizeFeiyuServiceUrl only accepts http(s) and trims trailing slash', () => {
  assert.equal(normalizeFeiyuServiceUrl('http://127.0.0.1:9880/'), 'http://127.0.0.1:9880');
  assert.equal(normalizeFeiyuServiceUrl('https://voice.example.com/'), 'https://voice.example.com');
  assert.throws(() => normalizeFeiyuServiceUrl('ftp://example.com'), /http/);
  assert.throws(() => normalizeFeiyuServiceUrl(''), /required/);
  assert.equal(normalizeFeiyuStyle('gentle'), 'gentle');
  assert.equal(normalizeFeiyuStyle('other'), 'cute');
});

test('FeiyuVoiceClient.speak submits a job, polls it and downloads the WAV', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/speech')) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer secret');
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { voice: 'feiyu', text: '你好', style: 'cute' });
      return jsonResponse({ id: 'job_1', state: 'queued' }, 202);
    }
    if (url.endsWith('/v1/jobs/job_1')) {
      return jsonResponse({ id: 'job_1', state: 'success', startedAt: '2026-01-01T00:00:00Z' });
    }
    if (url.endsWith('/v1/jobs/job_1/audio')) {
      return audioResponse(new Uint8Array([1, 2, 3, 4]));
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const client = new FeiyuVoiceClient({
    baseUrl: 'http://127.0.0.1:9880',
    apiKey: 'secret',
    fetchImpl,
    pollMs: 5,
    timeoutMs: 5_000,
  });
  const bytes = await client.speak({ text: '你好', style: 'cute' });
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
  const urls = calls.map((call) => call.url.replace('http://127.0.0.1:9880', ''));
  assert.deepEqual(urls, ['/v1/speech', '/v1/jobs/job_1', '/v1/jobs/job_1/audio']);
});

test('FeiyuVoiceClient.speak reports a failed job', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/speech')) return jsonResponse({ id: 'job_2', state: 'queued' }, 202);
    if (url.endsWith('/v1/jobs/job_2')) return jsonResponse({ id: 'job_2', state: 'failed', error: { message: '模型加载失败' } });
    throw new Error(`unexpected url: ${url}`);
  };
  const client = new FeiyuVoiceClient({ baseUrl: 'http://127.0.0.1:9880', fetchImpl, pollMs: 5, timeoutMs: 2_000 });
  await assert.rejects(() => client.speak({ text: '你好' }), (error) => {
    assert.ok(error instanceof FeiyuVoiceError);
    assert.equal(error.code, 'job-failed');
    assert.match(error.message, /模型加载失败/);
    return true;
  });
});

test('FeiyuVoiceClient surfaces HTTP errors with status and code', async () => {
  const fetchImpl = async () => jsonResponse({ error: { code: 'unauthorized', message: 'bad key' } }, 401);
  const client = new FeiyuVoiceClient({ baseUrl: 'http://127.0.0.1:9880', fetchImpl });
  await assert.rejects(() => client.speak({ text: '你好' }), (error) => {
    assert.ok(error instanceof FeiyuVoiceError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'unauthorized');
    return true;
  });
});

test('FeiyuVoiceClient rejects empty and oversized audio', async () => {
  const buildClient = (bytes) => new FeiyuVoiceClient({
    baseUrl: 'http://127.0.0.1:9880',
    fetchImpl: async (url) => {
      if (url.endsWith('/v1/speech')) return jsonResponse({ id: 'job_3', state: 'queued' }, 202);
      if (url.endsWith('/v1/jobs/job_3')) return jsonResponse({ id: 'job_3', state: 'success' });
      if (url.endsWith('/v1/jobs/job_3/audio')) return audioResponse(bytes);
      throw new Error(`unexpected url: ${url}`);
    },
    pollMs: 5,
    timeoutMs: 2_000,
  });
  await assert.rejects(() => buildClient(new Uint8Array()).speak({ text: '你好' }), /empty audio/);
});

test('FeiyuVoiceClient times out while waiting for the job', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/speech')) return jsonResponse({ id: 'job_4', state: 'queued' }, 202);
    if (url.endsWith('/v1/jobs/job_4')) return jsonResponse({ id: 'job_4', state: 'running' });
    throw new Error(`unexpected url: ${url}`);
  };
  const client = new FeiyuVoiceClient({ baseUrl: 'http://127.0.0.1:9880', fetchImpl, pollMs: 5, timeoutMs: 60 });
  await assert.rejects(() => client.speak({ text: '你好' }), (error) => {
    assert.equal(error.code, 'timeout');
    return true;
  });
});
