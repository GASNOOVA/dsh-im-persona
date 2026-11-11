// voice-hub 翻唱服务客户端（B 站链接 → 纯人声/混音翻唱 MP3）。
//
// 服务：tools/song2cute/voice_hub.py（部署在 GPU 机器上，默认端口 9860，Bearer 鉴权）。
// 协议：
//   POST /v1/cover { url, mix }        → 202 { id, state:'queued', kind:'cover' }
//   GET  /v1/jobs/{id}                 → { state, kind:'cover', title, durationSeconds, format, ... }
//   GET  /v1/jobs/{id}/audio           → MP3 字节
//   GET  /health                       → { status:'ok', ... }
//
// 翻唱是长任务（Demucs 分离 + RVC 分段转换，通常 1–5 分钟），所以轮询间隔和总超时都比 TTS 长。

const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_POLL_MS = 1_500;
const MAX_AUDIO_BYTES = 96 * 1024 * 1024;

export class CoverServiceError extends Error {
  constructor(message, { status = 0, code = '', body = null } = {}) {
    super(message);
    this.name = 'CoverServiceError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 归一化翻唱服务地址：只接受 http/https，去掉末尾斜杠。 */
export function normalizeCoverServiceBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('cover service URL is required');
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('cover service URL must use http or https');
  }
  return url.toString().replace(/\/$/, '');
}

export class CoverServiceClient {
  #baseUrl;
  #apiKey;
  #fetch;
  #timeoutMs;
  #pollMs;

  constructor({ baseUrl, apiKey = '', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS } = {}) {
    this.#baseUrl = normalizeCoverServiceBaseUrl(baseUrl);
    if (typeof fetchImpl !== 'function') throw new TypeError('cover service client requires a fetch implementation');
    this.#fetch = fetchImpl;
    this.#apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    this.#timeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.#pollMs = Number.isInteger(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  #headers(extra = {}) {
    return {
      ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
      Accept: 'application/json',
      ...extra,
    };
  }

  async #requestJson(method, path, { body, signal, timeoutMs = 30_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('cover service request timed out')), timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: this.#headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      if (!response.ok) {
        const code = parsed?.error?.code ?? parsed?.code ?? parsed?.detail ?? '';
        throw new CoverServiceError(
          parsed?.error?.message ?? parsed?.message ?? `cover service request failed (${response.status})`,
          { status: response.status, code: typeof code === 'string' ? code : '', body: parsed },
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof CoverServiceError) throw error;
      if (controller.signal.aborted) throw new CoverServiceError('cover service request was cancelled or timed out', { code: 'timeout' });
      throw new CoverServiceError(`cover service request failed: ${error?.message ?? error}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async health({ signal } = {}) {
    return this.#requestJson('GET', '/health', { signal, timeoutMs: 10_000 });
  }

  async submitCover({ url, mix = false, name = '', prompt = '', signal } = {}) {
    const job = await this.#requestJson('POST', '/v1/cover', {
      body: { url, mix: mix === true, ...(name ? { name } : {}), ...(prompt ? { prompt: String(prompt).slice(0, 300) } : {}) },
      signal,
    });
    const id = typeof job?.id === 'string' ? job.id : '';
    if (!id) throw new CoverServiceError('cover service returned no job id', { code: 'invalid-response', body: job });
    return id;
  }

  async getJob(id, { signal } = {}) {
    return this.#requestJson('GET', `/v1/jobs/${encodeURIComponent(id)}`, { signal, timeoutMs: 15_000 });
  }

  /** 轮询直到终态；超时返回中断错误。 */
  async waitForJob(id, { signal, timeoutMs = this.#timeoutMs, pollMs = this.#pollMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (signal?.aborted) throw new CoverServiceError('cover job was cancelled', { code: 'cancelled' });
      const job = await this.getJob(id, { signal });
      const state = typeof job?.state === 'string' ? job.state : '';
      if (state === 'success') return job;
      if (state === 'failed' || state === 'interrupted') {
        throw new CoverServiceError(job?.error?.message ?? 'cover job failed', {
          code: job?.error?.code ?? 'job-failed',
          body: job,
        });
      }
      if (Date.now() > deadline) throw new CoverServiceError('cover job timed out', { code: 'timeout', body: job });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async downloadAudio(id, { signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('cover audio download timed out')), 60_000);
    timer.unref?.();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.#fetch(`${this.#baseUrl}/v1/jobs/${encodeURIComponent(id)}/audio`, {
        headers: this.#headers({ Accept: 'audio/mpeg, audio/wav, application/octet-stream' }),
        signal: controller.signal,
      });
      if (!response.ok) throw new CoverServiceError(`cover audio download failed (${response.status})`, { status: response.status });
      const declared = Number(response.headers?.get?.('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
        throw new CoverServiceError(`cover audio is too large (${declared} bytes)`, { code: 'audio-too-large' });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
        throw new CoverServiceError(`cover audio has an invalid size (${bytes.length} bytes)`, { code: 'audio-too-large' });
      }
      return bytes;
    } catch (error) {
      if (error instanceof CoverServiceError) throw error;
      if (controller.signal.aborted) throw new CoverServiceError('cover audio download was cancelled', { code: 'cancelled' });
      throw new CoverServiceError(`cover audio download failed: ${error?.message ?? error}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 一站式：提交 → 轮询 → 下载。 */
  async fetchCover({ url, mix = false, name = '', prompt = '', signal } = {}) {
    const id = await this.submitCover({ url, mix, name, prompt, signal });
    const job = await this.waitForJob(id, { signal });
    const bytes = await this.downloadAudio(id, { signal });
    const format = job?.format === 'wav' ? 'wav' : 'mp3';
    return {
      id,
      bytes,
      format,
      title: typeof job?.title === 'string' ? job.title : '',
      durationSeconds: Number.isFinite(job?.durationSeconds) ? job.durationSeconds : null,
      bvid: typeof job?.bvid === 'string' ? job.bvid : '',
      url: typeof job?.url === 'string' ? job.url : url,
      mix: job?.mix === true,
    };
  }
}
