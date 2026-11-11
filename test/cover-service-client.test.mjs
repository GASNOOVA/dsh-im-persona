import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CoverServiceClient,
  CoverServiceError,
  normalizeCoverServiceBaseUrl,
} from '../src/channels/wechat-personal/cover-service-client.mjs';

test('normalizeCoverServiceBaseUrl trims trailing slashes and rejects non-http urls', () => {
  assert.equal(normalizeCoverServiceBaseUrl('http://127.0.0.1:9860/'), 'http://127.0.0.1:9860');
  assert.equal(normalizeCoverServiceBaseUrl(' https://voice.example.com/base/ '), 'https://voice.example.com/base');
  assert.throws(() => normalizeCoverServiceBaseUrl('ftp://example.com'), /http/u);
  assert.throws(() => normalizeCoverServiceBaseUrl(''), /required/u);
});

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { fetchImpl, calls };
}

test('fetchCover submits, polls and downloads the cover audio', async () => {
  let polls = 0;
  const { fetchImpl, calls } = fakeFetch(async (url, init) => {
    if (url.endsWith('/v1/cover')) {
      return { ok: true, status: 202, text: async () => JSON.stringify({ id: 'job-1', state: 'queued' }) };
    }
    if (url.endsWith('/v1/jobs/job-1') && init.method === 'GET') {
      polls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(polls === 1
          ? { id: 'job-1', state: 'running' }
          : { id: 'job-1', state: 'success', format: 'mp3', title: '测试歌曲', durationSeconds: 12.5, bvid: 'BV1xx411c7mD', mix: false }),
      };
    }
    if (url.endsWith('/v1/jobs/job-1/audio')) {
      return { ok: true, status: 200, headers: { get: () => '4' }, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  });
  const client = new CoverServiceClient({ baseUrl: 'http://127.0.0.1:9860', apiKey: 'secret', fetchImpl, pollMs: 1 });
  const result = await client.fetchCover({
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    prompt: '温柔一点',
    mix: false,
  });
  assert.equal(result.format, 'mp3');
  assert.equal(result.title, '测试歌曲');
  assert.equal(result.durationSeconds, 12.5);
  assert.equal(result.bvid, 'BV1xx411c7mD');
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  const submit = calls.find((call) => call.url.endsWith('/v1/cover'));
  const body = JSON.parse(submit.init.body);
  assert.equal(body.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(body.prompt, '温柔一点');
  assert.equal(body.mix, false);
  assert.equal(submit.init.headers.Authorization, 'Bearer secret');
});

test('fetchCover reports failed jobs as CoverServiceError', async () => {
  const { fetchImpl } = fakeFetch(async (url) => {
    if (url.endsWith('/v1/cover')) return { ok: true, status: 202, text: async () => JSON.stringify({ id: 'job-2' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'job-2', state: 'failed', error: { code: 'cover-failed', message: '下载失败' } }) };
  });
  const client = new CoverServiceClient({ baseUrl: 'http://127.0.0.1:9860', fetchImpl, pollMs: 1 });
  await assert.rejects(() => client.fetchCover({ url: 'https://b23.tv/abcdEF' }), (error) => {
    assert.ok(error instanceof CoverServiceError);
    assert.equal(error.code, 'cover-failed');
    return true;
  });
});

test('health and network failures surface as CoverServiceError', async () => {
  const { fetchImpl } = fakeFetch(async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ detail: 'busy' }) }));
  const client = new CoverServiceClient({ baseUrl: 'http://127.0.0.1:9860', fetchImpl });
  await assert.rejects(() => client.health(), (error) => {
    assert.ok(error instanceof CoverServiceError);
    assert.equal(error.status, 503);
    return true;
  });
});
