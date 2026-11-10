// 飞鱼声音服务（feiyu_voice_service）HTTP 客户端。
//
// 服务由仓库 `astrbot_plugin_feiyu_voice/server/` 提供：本地 FastAPI 异步任务网关，
// 默认 `http://127.0.0.1:9880`，Bearer 鉴权；提交语音任务后轮询 job，成功再下载 WAV。
//
// 该客户端只依赖全局 fetch，便于单元测试注入 fake fetch；API Key 由宿主从私有文件读取，
// 本模块不负责持久化任何凭据。
//
// 协议（见 server/INSTALL_AGENT.md）：
//   POST /v1/speech  { voice:'feiyu', text, style }  → 202 { id }
//   GET  /v1/jobs/{id}                              → { state: queued|running|success|failed|interrupted }
//   GET  /v1/jobs/{id}/audio                        → WAV 字节
//   GET  /health                                    → { status: 'ok' }

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 500;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

export class FeiyuVoiceError extends Error {
  constructor(message, { status = 0, code = '', body = null } = {}) {
    super(message);
    this.name = 'FeiyuVoiceError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 归一化声音服务地址：只接受 http/https，去掉末尾斜杠；非法时抛错。 */
export function normalizeFeiyuServiceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('feiyu voice service URL is required');
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('feiyu voice service URL must use http or https');
  }
  return url.toString().replace(/\/$/, '');
}

/** 合法声线；未知值回退 cute。 */
export function normalizeFeiyuStyle(value) {
  return value === 'gentle' ? 'gentle' : 'cute';
}

export class FeiyuVoiceClient {
  #baseUrl;
  #apiKey;
  #fetch;
  #timeoutMs;
  #pollMs;

  constructor({ baseUrl, apiKey = '', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS } = {}) {
    this.#baseUrl = normalizeFeiyuServiceUrl(baseUrl);
    if (typeof fetchImpl !== 'function') throw new TypeError('feiyu voice client requires a fetch implementation');
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

  async #requestJson(method, path, { body, signal, timeoutMs = this.#timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('feiyu voice request timed out')), timeoutMs);
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
      if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
      if (!response.ok) {
        const code = parsed?.error?.code ?? parsed?.code ?? parsed?.detail ?? '';
        throw new FeiyuVoiceError(
          parsed?.error?.message ?? parsed?.message ?? `feiyu voice request failed (${response.status})`,
          { status: response.status, code: typeof code === 'string' ? code : '', body: parsed },
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof FeiyuVoiceError) throw error;
      if (controller.signal.aborted) throw new FeiyuVoiceError('feiyu voice request was cancelled or timed out', { code: 'timeout' });
      throw new FeiyuVoiceError(`feiyu voice request failed: ${error?.message ?? error}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #requestBytes(path, { signal, maxBytes = MAX_AUDIO_BYTES } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('feiyu voice download timed out')), this.#timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: this.#headers({ Accept: 'audio/wav, application/octet-stream' }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new FeiyuVoiceError(`feiyu voice audio download failed (${response.status})`, { status: response.status });
      }
      const declared = Number(response.headers?.get?.('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new FeiyuVoiceError('feiyu voice audio is too large', { code: 'too-large' });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new FeiyuVoiceError('feiyu voice audio is too large', { code: 'too-large' });
      if (bytes.byteLength === 0) throw new FeiyuVoiceError('feiyu voice returned empty audio', { code: 'empty-audio' });
      return bytes;
    } catch (error) {
      if (error instanceof FeiyuVoiceError) throw error;
      if (controller.signal.aborted) throw new FeiyuVoiceError('feiyu voice download timed out', { code: 'timeout' });
      throw new FeiyuVoiceError(`feiyu voice download failed: ${error?.message ?? error}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 服务健康检查；失败抛错。 */
  async health({ signal } = {}) {
    return this.#requestJson('GET', '/health', { signal, timeoutMs: 10_000 });
  }

  /**
   * 合成一条语音。成功返回 WAV 字节（Uint8Array）。
   * 轮询 job 直到 success/failed/interrupted 或整体超时。
   */
  async speak({ text, style = 'cute', voice = 'feiyu', signal } = {}) {
    const content = typeof text === 'string' ? text.trim() : '';
    if (!content) throw new TypeError('text is required');
    if (content.length > 1_000) throw new RangeError('text is too long for one voice note');
    const submitted = await this.#requestJson('POST', '/v1/speech', {
      signal,
      body: { voice, text: content, style: normalizeFeiyuStyle(style) },
    });
    const jobId = typeof submitted?.id === 'string'
      ? submitted.id
      : (typeof submitted?.jobId === 'string' ? submitted.jobId : '');
    if (!jobId) throw new FeiyuVoiceError('feiyu voice service did not return a job id', { code: 'invalid-response' });
    const deadline = Date.now() + this.#timeoutMs;
    let job = submitted;
    while (Date.now() < deadline) {
      const state = typeof job?.state === 'string' ? job.state : '';
      if (state === 'success') {
        const bytes = await this.#requestBytes(`/v1/jobs/${encodeURIComponent(jobId)}/audio`, { signal });
        return bytes;
      }
      if (state === 'failed' || state === 'interrupted') {
        throw new FeiyuVoiceError(job?.error?.message ?? `feiyu voice job ${state}`, { code: 'job-failed', body: job });
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.#pollMs);
        timer.unref?.();
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (signal?.aborted) throw new FeiyuVoiceError('feiyu voice job was cancelled', { code: 'cancelled' });
      job = await this.#requestJson('GET', `/v1/jobs/${encodeURIComponent(jobId)}`, { signal });
    }
    throw new FeiyuVoiceError('feiyu voice job timed out', { code: 'timeout' });
  }
}
