import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  HarnessClient,
  HarnessHealthError,
  HarnessInteractionError,
  HarnessRpcError,
  HarnessTransportError,
} from '../../../src/channels/shared/harness-client.mjs';

function localClient(apiProxy, options = {}) {
  return new HarnessClient({
    apiProxy,
    workspace: '/tmp/dsh-im-test',
    interactionReconnectDelayMs: 0,
    fetchImpl: () => assert.fail('in-process calls must not use HTTP'),
    createWebSocket: () => assert.fail('in-process events must not use WebSocket'),
    ...options,
  });
}

async function eventually(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('condition was not met');
}

// The real Host registers eagerly, then exposes a signal-controlled iterator.
// Reopening replays pending questions; since is deliberately not used.
function hostFixture() {
  const streams = new Set();
  const pending = new Map();
  const history = [];
  const prompts = [];
  const responses = [];
  let historyReads = 0;
  let opened = 0;
  const host = { streams, pending, history, prompts, responses, onPrompt: () => {} };
  const success = (rpcId, value) => ({ rpcId, result: { ok: true, value } });
  host.emit = (frame) => { for (const stream of streams) stream.push(frame); };
  host.append = (event) => {
    history.push({ event });
    host.emit({ rpcId: `event-${event.seq}`, payload: { type: 'session/event', sessionId: 'session', event } });
  };
  host.question = () => {
    const frame = {
      rpcId: 'question-rpc',
      payload: { type: 'question/requested', sessionId: 'session', questions: [] },
    };
    pending.set(frame.rpcId, frame);
    host.emit(frame);
  };
  host.apiProxy = {
    host: { describe: ({ rpcId }) => success(rpcId, {}) },
    workspace: { list: ({ rpcId }) => success(rpcId, { items: [], archivedSessionIds: [] }) },
    sessions: {
      history: ({ rpcId }) => {
        historyReads += 1;
        return success(rpcId, { events: [...history] });
      },
      prompt: ({ rpcId, payload }) => {
        assert.equal(streams.size > 0, true, 'subscribe before submitting a prompt');
        prompts.push({ rpcId, payload });
        host.onPrompt(rpcId, payload);
        return success(rpcId, {});
      },
    },
    events: {
      mux(request, signal) {
        assert.deepEqual(request.payload, {});
        opened += 1;
        const queue = [...pending.values()];
        let wake;
        let ended = false;
        const stream = {
          push(frame) { queue.push(frame); wake?.(); },
          end() { ended = true; wake?.(); },
        };
        streams.add(stream);
        return (async function* () {
          const abort = () => stream.end();
          signal.addEventListener('abort', abort, { once: true });
          try {
            while (!ended && !signal.aborted) {
              if (queue.length) yield queue.shift();
              else await new Promise((resolve) => { wake = resolve; });
            }
          } finally {
            signal.removeEventListener('abort', abort);
            streams.delete(stream);
          }
        })();
      },
    },
    respond(envelope) {
      responses.push(envelope);
      pending.delete(envelope.rpcId);
      return { accepted: true };
    },
  };
  Object.defineProperties(host, {
    historyReads: { get: () => historyReads },
    opened: { get: () => opened },
  });
  return host;
}

for (const withStepEnd of [false, true]) {
for (const progressMode of ['all', 'live']) {
  test(`${progressMode} recovers a final message missed after the turn is bound (step/end=${withStepEnd})`, async () => {
    const host = hostFixture();
    let emission;
    let sawEarlierAnswer = false;
    host.onPrompt = (rpcId) => {
      emission = (async () => {
        host.append({ type: 'turn/start', seq: 0, data: { turn: 1 } });
        host.append({ type: 'user/message', seq: 1, data: { turn: 1, source: { rpcId } } });
        host.append({ type: 'assistant/message', seq: 2, data: {
          turn: 1, step: 0, message: { content: [{ type: 'text', text: '先读取文件' }] },
        } });
        // Wait for the real client to consume the beginning of the turn,
        // through the authoritative history poll.
        await eventually(() => sawEarlierAnswer);
        for (const stream of host.streams) stream.end();
        // Durable history retains the final message emitted during the gap.
        host.history.push({ event: { type: 'assistant/message', seq: 3, data: {
          turn: 1, step: 1, message: { content: [{ type: 'text', text: '最终答案' }] },
        } } });
        await eventually(() => host.opened >= 2 && host.streams.size > 0);
        if (withStepEnd) host.append({ type: 'step/end', seq: 4, data: { turn: 1, step: 1 } });
        host.append({ type: 'turn/end', seq: withStepEnd ? 5 : 4, data: {
          turn: 1, reason: { kind: 'completed' },
        } });
      })();
    };
    const client = localClient(host.apiProxy);
    try {
      const answer = await client.ask('session', 'hello', {
        progressMode,
        onUpdate: (update) => {
          if (update.type === 'assistant-message' && update.text === '先读取文件') {
            sawEarlierAnswer = true;
          }
        },
        onInteraction: () => {},
        timeoutMs: 3000,
      });
      assert.equal(answer, '先读取文件\n\n最终答案');
    } finally {
      await emission;
    }
  });
}
}
