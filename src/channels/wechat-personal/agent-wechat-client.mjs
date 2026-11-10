// agent-wechat daemon HTTP 客户端：只依赖全局 fetch，便于在 Node 与测试中复用。
//
// 该模块负责「微信个人号」通道的底层协议：
// - 读取账号、会话、群成员、历史消息；
// - 发送文本（支持真实 @ 提及）；
// - 订阅 SSE 事件流（message.committed 等），由上层负责游标持久化与重连。
//
// 安全：daemon 只应监听回环地址；token 由调用方从私有文件读取后传入，本模块不落盘。

const DEFAULT_TIMEOUT_MS = 20_000;

export class AgentWechatError extends Error {
  constructor(message, { status = 0, code = '', body = null } = {}) {
    super(message);
    this.name = 'AgentWechatError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 归一化 daemon 地址：只接受 http/https，去掉末尾斜杠；非法时抛错。 */
export function normalizeAgentWechatDaemonUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('agent-wechat daemon URL is required');
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('agent-wechat daemon URL must use http or https');
  }
  return url.toString().replace(/\/$/, '');
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function parseSseChunk(chunk) {
  let id = '';
  let eventName = '';
  const dataLines = [];
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { id, event: eventName, cursor: id, kind: '', payload: null, raw };
  }
  return {
    id,
    event: eventName,
    cursor: typeof parsed?.cursor === 'string' ? parsed.cursor : id,
    kind: typeof parsed?.kind === 'string' ? parsed.kind : '',
    payload: parsed?.data ?? null,
    createdAt: typeof parsed?.createdAt === 'string' ? parsed.createdAt : null,
    raw: parsed,
  };
}

export class AgentWechatClient {
  #baseUrl;
  #token;
  #accountId;
  #fetch;
  #timeoutMs;

  constructor({ baseUrl, token, accountId, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#baseUrl = normalizeAgentWechatDaemonUrl(baseUrl);
    if (typeof token !== 'string' || !token.trim()) throw new TypeError('agent-wechat API token is required');
    if (typeof accountId !== 'string' || !accountId.trim()) throw new TypeError('agent-wechat account id is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('agent-wechat client requires a fetch implementation');
    this.#token = token.trim();
    this.#accountId = accountId.trim();
    this.#fetch = fetchImpl;
    this.#timeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  get accountId() {
    return this.#accountId;
  }

  #headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.#token}`,
      Accept: 'application/json',
      ...extra,
    };
  }

  async #request(method, path, { body, signal, headers = {}, timeoutMs = this.#timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('agent-wechat request timed out')), timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: this.#headers({
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = null; }
      }
      if (!response.ok) {
        const code = parsed?.error?.code ?? parsed?.code ?? '';
        throw new AgentWechatError(
          parsed?.error?.message ?? parsed?.message ?? `agent-wechat request failed (${response.status})`,
          { status: response.status, code: typeof code === 'string' ? code : '', body: parsed },
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof AgentWechatError) throw error;
      if (controller.signal.aborted) {
        throw new AgentWechatError('agent-wechat request was cancelled or timed out', { code: 'timeout' });
      }
      throw new AgentWechatError(`agent-wechat request failed: ${error?.message ?? error}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** daemon 健康检查（无需鉴权）。 */
  async health({ signal } = {}) {
    const response = await this.#fetch(`${this.#baseUrl}/health`, { signal });
    if (!response.ok) throw new AgentWechatError(`agent-wechat health check failed (${response.status})`, { status: response.status });
    return response.json();
  }

  async listAccounts({ signal } = {}) {
    const body = await this.#request('GET', '/v1/accounts', { signal });
    return Array.isArray(body?.items) ? body.items : [];
  }

  async getAccount(accountId = this.#accountId, { signal } = {}) {
    const body = await this.#request('GET', `/v1/accounts/${encode(accountId)}`, { signal });
    return body?.account ?? body?.item ?? body ?? null;
  }

  async listThreads({ limit = 50, signal } = {}) {
    const body = await this.#request('GET', `/v1/accounts/${encode(this.#accountId)}/threads?limit=${encode(limit)}`, { signal });
    return Array.isArray(body?.items) ? body.items : [];
  }

  /** 返回 daemon 当前事件游标，用于首次启动时跳过历史回放。 */
  async latestEventCursor({ signal } = {}) {
    const body = await this.#request('GET', `/v1/accounts/${encode(this.#accountId)}/threads?limit=1`, { signal });
    return typeof body?.asOfEventCursor === 'string' && body.asOfEventCursor ? body.asOfEventCursor : null;
  }

  async listMessages(threadId, { limit = 50, signal } = {}) {
    const body = await this.#request(
      'GET',
      `/v1/accounts/${encode(this.#accountId)}/threads/${encode(threadId)}/messages?limit=${encode(limit)}`,
      { signal },
    );
    return Array.isArray(body?.items) ? body.items : [];
  }

  async getMessage(messageId, { signal } = {}) {
    const body = await this.#request('GET', `/v1/accounts/${encode(this.#accountId)}/messages/${encode(messageId)}`, { signal });
    return body?.message ?? body?.item ?? body ?? null;
  }

  async getGroup(groupId, { signal } = {}) {
    const body = await this.#request('GET', `/v1/accounts/${encode(this.#accountId)}/groups/${encode(groupId)}`, { signal });
    return body?.group ?? body?.item ?? body ?? null;
  }

  async listMembers(groupId, { limit = 100, signal } = {}) {
    const body = await this.#request(
      'GET',
      `/v1/accounts/${encode(this.#accountId)}/groups/${encode(groupId)}/members?limit=${encode(limit)}`,
      { signal },
    );
    return Array.isArray(body?.items) ? body.items : [];
  }

  // TODO(识图暂停)：图片识图能力暂时下线；以下媒体下载方法保留为注释，待恢复识图时启用。
  // /** 列出某条消息的附件（图片/文件/语音等）。 */
  // async listMessageMedia(messageId, { signal } = {}) {
  //   const body = await this.#request(
  //     'GET',
  //     `/v1/accounts/${encode(this.#accountId)}/messages/${encode(messageId)}/media`,
  //     { signal },
  //   );
  //   return Array.isArray(body?.items) ? body.items : [];
  // }
  //
  // /** 请求 daemon 下载某条消息的附件；返回异步 job。 */
  // async startMediaTransfer(messageId, { assetId = null, quality = 'best', signal } = {}) {
  //   const body = await this.#request(
  //     'POST',
  //     `/v1/accounts/${encode(this.#accountId)}/messages/${encode(messageId)}/media-transfers`,
  //     { signal, body: { messageId, assetId, quality } },
  //   );
  //   return body?.job ?? body ?? null;
  // }
  //
  // /** 查询附件下载/上传任务。 */
  // async getJob(jobId, { signal } = {}) {
  //   const body = await this.#request('GET', `/v1/accounts/${encode(this.#accountId)}/jobs/${encode(jobId)}`, { signal });
  //   return body?.job ?? body ?? null;
  // }
  //
  // async #requestBytes(path, { signal, maxBytes = 20 * 1024 * 1024 } = {}) {
  //   const controller = new AbortController();
  //   const timer = setTimeout(() => controller.abort(new Error('agent-wechat media request timed out')), this.#timeoutMs);
  //   timer.unref?.();
  //   const onAbort = () => controller.abort(signal?.reason);
  //   signal?.addEventListener('abort', onAbort, { once: true });
  //   try {
  //     const response = await this.#fetch(`${this.#baseUrl}${path}`, {
  //       headers: this.#headers({ Accept: '*/*' }),
  //       signal: controller.signal,
  //     });
  //     if (!response.ok) {
  //       throw new AgentWechatError(`agent-wechat media request failed (${response.status})`, { status: response.status });
  //     }
  //     const declared = Number(response.headers.get('content-length'));
  //     if (Number.isFinite(declared) && declared > maxBytes) {
  //       throw new AgentWechatError('agent-wechat media is too large', { code: 'media-too-large' });
  //     }
  //     const bytes = new Uint8Array(await response.arrayBuffer());
  //     if (bytes.byteLength > maxBytes) {
  //       throw new AgentWechatError('agent-wechat media is too large', { code: 'media-too-large' });
  //     }
  //     return { bytes, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  //   } catch (error) {
  //     if (error instanceof AgentWechatError) throw error;
  //     if (controller.signal.aborted) {
  //       throw new AgentWechatError('agent-wechat media request was cancelled or timed out', { code: 'timeout' });
  //     }
  //     throw new AgentWechatError(`agent-wechat media request failed: ${error?.message ?? error}`, { code: 'network' });
  //   } finally {
  //     clearTimeout(timer);
  //     signal?.removeEventListener('abort', onAbort);
  //   }
  // }
  //
  // /**
  //  * 下载某条消息中的第一张图片。
  //  * 流程：列附件 → 必要时请求下载并轮询 job → 读取 /media/{assetId}/content。
  //  * 返回 { assetId, messageId, name, mediaType, bytes }，供 Harness 的 images 入参使用。
  //  */
  // async downloadMessageImage(messageId, {
  //   quality = 'best',
  //   signal,
  //   maxBytes = 20 * 1024 * 1024,
  //   waitMs = 30_000,
  //   pollMs = 400,
  // } = {}) {
  //   const isImage = (asset) => (typeof asset?.kind === 'string'
  //     ? asset.kind === 'image'
  //     : /^image\//i.test(String(asset?.contentType ?? '')));
  //   let assets = await this.listMessageMedia(messageId, { signal });
  //   let asset = assets.find(isImage);
  //   if (!asset) throw new AgentWechatError('message has no image attachment', { code: 'media-not-found' });
  //   if (asset.state !== 'available') {
  //     const job = await this.startMediaTransfer(messageId, { assetId: asset.id, quality, signal });
  //     const jobId = typeof job?.id === 'string' ? job.id : '';
  //     if (!jobId) throw new AgentWechatError('agent-wechat did not return a media job', { code: 'media-transfer-failed' });
  //     const deadline = Date.now() + Math.max(1_000, waitMs);
  //     for (;;) {
  //       const current = await this.getJob(jobId, { signal });
  //       const state = typeof current?.state === 'string' ? current.state : '';
  //       if (state === 'available') break;
  //       if (['failed', 'expired', 'unsupported', 'cancelled', 'needs_review'].includes(state)) {
  //         throw new AgentWechatError(`agent-wechat media download ${state}`, { code: 'media-transfer-failed', body: current });
  //       }
  //       if (Date.now() >= deadline) {
  //         throw new AgentWechatError('agent-wechat media download timed out', { code: 'timeout' });
  //       }
  //       await new Promise((resolve) => {
  //         if (signal?.aborted) return resolve();
  //         const timer = setTimeout(resolve, pollMs);
  //         timer.unref?.();
  //         signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  //       });
  //       signal?.throwIfAborted?.();
  //     }
  //     assets = await this.listMessageMedia(messageId, { signal });
  //     asset = assets.find((item) => item.id === asset.id) ?? asset;
  //   }
  //   const content = await this.#requestBytes(
  //     `/v1/accounts/${encode(this.#accountId)}/media/${encode(asset.id)}/content`,
  //     { signal, maxBytes },
  //   );
  //   return {
  //     assetId: asset.id,
  //     messageId,
  //     name: typeof asset.fileName === 'string' && asset.fileName
  //       ? asset.fileName
  //       : (typeof asset.name === 'string' && asset.name ? asset.name : `${asset.id}.jpg`),
  //     mediaType: content.contentType,
  //     bytes: content.bytes,
  //   };
  // }
  //
  //

  /** 发送文本；群聊可带 mentions.userIds / mentions.all。 */
  async sendText({ threadId, text, mentions, idempotencyKey, signal, kind = 'text' } = {}) {
    if (typeof threadId !== 'string' || !threadId) throw new TypeError('threadId is required');
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('text is required');
    const key = typeof idempotencyKey === 'string' && idempotencyKey
      ? idempotencyKey
      : `dsh-im-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const body = await this.#request('POST', `/v1/accounts/${encode(this.#accountId)}/sends`, {
      signal,
      headers: { 'Idempotency-Key': key },
      body: {
        kind,
        threadId,
        text,
        ...(mentions && typeof mentions === 'object' ? { mentions } : {}),
      },
    });
    return body;
  }

  /**
   * SSE 事件流：断线重连时由调用方传入 after 游标补发。
   * yield { id, cursor, kind, payload, createdAt }。
   */
  async *streamEvents({ after, signal } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const url = new URL(`${this.#baseUrl}/v1/accounts/${encode(this.#accountId)}/events/stream`);
      if (after !== undefined && after !== null && after !== '') url.searchParams.set('after', String(after));
      const response = await this.#fetch(url, {
        headers: this.#headers({ Accept: 'text/event-stream' }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AgentWechatError(`agent-wechat event stream failed (${response.status})`, { status: response.status });
      }
      if (!response.body) throw new AgentWechatError('agent-wechat event stream has no body', { code: 'no-body' });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = parseSseChunk(chunk);
            if (event) yield event;
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}
