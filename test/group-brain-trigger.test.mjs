// 群聊「自动接话」触发引擎测试：用可注入的假时钟/假定时器精确控制静默与限流窗口。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_GROUP_TRIGGER,
  GroupTriggerEngine,
  normalizeGroupTriggerSettings,
} from '../src/channels/shared/group-brain/group-trigger.mjs';

const START = 1_700_000_000_000;

/** 极简假时钟：now + 定时器队列，advance() 按到期时间顺序触发回调。 */
function createClock(start = START) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeoutFn(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, at: current + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let dueId = null;
        let dueTimer = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (dueTimer === null || timer.at < dueTimer.at)) {
            dueId = id;
            dueTimer = timer;
          }
        }
        if (dueId === null) break;
        timers.delete(dueId);
        current = dueTimer.at;
        dueTimer.callback();
      }
      current = target;
    },
  };
}

function createEngine(clock, overrides = {}, hooks = {}) {
  const ambients = [];
  const engine = new GroupTriggerEngine({
    settings: { ...DEFAULT_GROUP_TRIGGER, ...overrides },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onAmbient(chatId, info) {
      ambients.push({ chatId, info });
      hooks.onAmbient?.(chatId, info);
    },
    logger: { warn() {}, error() {} },
  });
  return { engine, ambients };
}

function observe(engine, chatId, senderName, options = {}) {
  return engine.observe({ chatId, senderName, ...options });
}

test('normalizeGroupTriggerSettings：缺省合并默认值，显式值原样保留', () => {
  assert.deepEqual(normalizeGroupTriggerSettings({}), { ...DEFAULT_GROUP_TRIGGER });

  const merged = normalizeGroupTriggerSettings({
    silenceMs: 5_000,
    minMessages: 3,
    cooldownMs: 0,
    maxPerHour: 2,
    maxPerDay: 10,
  });
  assert.deepEqual(merged, {
    silenceMs: 5_000,
    minMessages: 3,
    cooldownMs: 0,
    maxPerHour: 2,
    maxPerDay: 10,
    followUpMs: DEFAULT_GROUP_TRIGGER.followUpMs,
    followUpMaxReplies: DEFAULT_GROUP_TRIGGER.followUpMaxReplies,
    followUpMinIntervalMs: DEFAULT_GROUP_TRIGGER.followUpMinIntervalMs,
  });
  assert.equal(Object.isFrozen(merged), true);
  // 未知字段忽略；缺省字段继续合并默认值。
  assert.deepEqual(
    normalizeGroupTriggerSettings({ maxPerHour: 2, unknown: 1 }),
    { ...DEFAULT_GROUP_TRIGGER, maxPerHour: 2 },
  );
});

test('normalizeGroupTriggerSettings：非法输入（类型/负数/小数/NaN）返回 null', () => {
  const invalid = [
    null,
    undefined,
    'x',
    [],
    { silenceMs: 0 },
    { silenceMs: -1 },
    { minMessages: 1.5 },
    { cooldownMs: -1 },
    { maxPerHour: 0 },
    { maxPerDay: Number.POSITIVE_INFINITY },
    { silenceMs: Number.NaN },
  ];
  for (const value of invalid) {
    assert.equal(normalizeGroupTriggerSettings(value), null, `should reject ${JSON.stringify(value)}`);
  }
});

test('被 @ 的消息：返回 direct，清空缓冲与静默定时器', () => {
  const clock = createClock();
  const { engine, ambients } = createEngine(clock, { silenceMs: 1_000, minMessages: 2 });

  assert.equal(observe(engine, 'g1', '甲'), 'record');
  assert.equal(engine.status('g1').buffered, 1);
  assert.equal(engine.status('g1').pendingTimer, true);
  assert.equal(clock.pending(), 1);

  assert.equal(engine.observe({ chatId: 'g1', mentionedBot: true, senderName: '甲' }), 'direct');
  assert.equal(engine.status('g1').buffered, 0);
  assert.equal(engine.status('g1').pendingTimer, false);
  assert.equal(clock.pending(), 0);

  clock.advance(60_000);
  assert.equal(ambients.length, 0);
});

test('静默到期且消息数达标：触发 onAmbient 并带窗口信息', () => {
  const clock = createClock();
  const { engine, ambients } = createEngine(clock, { silenceMs: 1_000, minMessages: 2, cooldownMs: 0 });

  const firstAt = clock.now();
  observe(engine, 'g1', '甲');
  clock.advance(200);
  observe(engine, 'g1', '乙');
  const secondAt = clock.now();

  clock.advance(999);
  assert.equal(ambients.length, 0, 'silenceMs 未到不应触发');
  clock.advance(1);

  assert.equal(ambients.length, 1);
  assert.equal(ambients[0].chatId, 'g1');
  assert.deepEqual(ambients[0].info, {
    messageCount: 2,
    senders: ['甲', '乙'],
    fromAt: firstAt,
    toAt: secondAt,
  });
  assert.equal(engine.status('g1').buffered, 0);
  assert.equal(engine.status('g1').lastAmbientAt, secondAt + 1_000);
});

test('消息数不足 minMessages：不触发并清空缓冲（防抖）', () => {
  const clock = createClock();
  const { engine, ambients } = createEngine(clock, { silenceMs: 500, minMessages: 2, cooldownMs: 0 });

  observe(engine, 'g1', '甲');
  clock.advance(500);
  assert.equal(ambients.length, 0);
  assert.equal(engine.status('g1').buffered, 0);
  assert.equal(engine.status('g1').pendingTimer, false);

  // 下一次静默窗口重新累计：两条消息即可触发。
  observe(engine, 'g1', '甲');
  observe(engine, 'g1', '乙');
  clock.advance(500);
  assert.equal(ambients.length, 1);
  assert.equal(ambients[0].info.messageCount, 2);
});

test('cooldown：距上次主动接话不足 cooldownMs 时不触发，冷却期过后恢复', () => {
  const clock = createClock();
  const { engine, ambients } = createEngine(clock, {
    silenceMs: 100,
    minMessages: 1,
    cooldownMs: 1_000,
    maxPerHour: 10,
    maxPerDay: 10,
  });

  observe(engine, 'g1', '甲');
  clock.advance(100);
  assert.equal(ambients.length, 1);

  observe(engine, 'g1', '甲');
  clock.advance(100);
  assert.equal(ambients.length, 1, '冷却期内不应再次触发');
  assert.equal(engine.status('g1').buffered, 0);

  clock.advance(1_000);
  observe(engine, 'g1', '甲');
  clock.advance(100);
  assert.equal(ambients.length, 2);
});

test('每小时上限 maxPerHour：达到后本小时内不再触发', () => {
  const clock = createClock();
  const { engine, ambients } = createEngine(clock, {
    silenceMs: 10,
    minMessages: 1,
    cooldownMs: 0,
    maxPerHour: 1,
    maxPerDay: 10,
  });

  observe(engine, 'g1', '甲');
  clock.advance(10);
  assert.equal(ambients.length, 1);

  observe(engine, 'g1', '甲');
  clock.advance(10);
  assert.equal(ambients.length, 1, '本小时已达上限');
  assert.equal(engine.status('g1').hourlyCount, 1);
  assert.equal(engine.status('g1').dailyCount, 1);
});

test('每日上限 maxPerDay：滑动 24h 窗口内达到上限后不再触发，窗口滑过后恢复', () => {
  const clock = createClock();
  const { engine, ambients } = createEngine(clock, {
    silenceMs: 10,
    minMessages: 1,
    cooldownMs: 0,
    maxPerHour: 10,
    maxPerDay: 1,
  });

  observe(engine, 'g1', '甲');
  clock.advance(10);
  assert.equal(ambients.length, 1);

  observe(engine, 'g1', '甲');
  clock.advance(10);
  assert.equal(ambients.length, 1, '本日已达上限');
  assert.equal(engine.status('g1').dailyCount, 1);

  // 滑过 24h 后旧记录不再计入日上限。
  clock.advance(86_400_000);
  observe(engine, 'g1', '甲');
  clock.advance(10);
  assert.equal(ambients.length, 2);
  assert.equal(engine.status('g1').dailyCount, 1);
});

test('status：未知群返回零值，已有群返回缓冲/计时器/计数快照', () => {
  const clock = createClock();
  const { engine } = createEngine(clock, { silenceMs: 1_000, minMessages: 2, cooldownMs: 0 });

  assert.deepEqual(engine.status('nope'), {
    buffered: 0,
    lastAmbientAt: null,
    hourlyCount: 0,
    dailyCount: 0,
    pendingTimer: false,
    followUp: { active: false, remainingReplies: 0 },
  });

  observe(engine, 'g1', '甲');
  const status = engine.status('g1');
  assert.equal(status.buffered, 1);
  assert.equal(status.pendingTimer, true);
  assert.equal(status.lastAmbientAt, null);
  assert.equal(status.hourlyCount, 0);
});

test('公开 evaluate：可注入 now 立即评估并清掉待触发定时器', () => {
  const clock = createClock();
  const { engine, ambients } = createEngine(clock, { silenceMs: 60_000, minMessages: 2, cooldownMs: 0 });

  observe(engine, 'g1', '甲');
  observe(engine, 'g1', '乙');
  assert.equal(clock.pending(), 1);

  const info = engine.evaluate('g1', { now: clock.now() + 10 });
  assert.equal(info.messageCount, 2);
  assert.equal(ambients.length, 1);
  assert.equal(clock.pending(), 0, 'evaluate 应清掉静默定时器');
  assert.equal(engine.status('g1').pendingTimer, false);

  // 定时器已被清掉，时间推进不会重复触发。
  clock.advance(120_000);
  assert.equal(ambients.length, 1);

  assert.equal(engine.evaluate('unknown'), null);
});

test('dispose：按群/全部清理定时器与缓冲，到期不再回调', () => {
  const clock = createClock();
  const { engine, ambients } = createEngine(clock, { silenceMs: 1_000, minMessages: 2, cooldownMs: 0 });

  observe(engine, 'g1', '甲');
  observe(engine, 'g2', '乙');
  assert.equal(clock.pending(), 2);

  engine.dispose('g1');
  assert.equal(clock.pending(), 1);
  assert.equal(engine.status('g1').buffered, 0);
  assert.equal(engine.status('g1').pendingTimer, false);

  clock.advance(1_000);
  assert.equal(ambients.length, 0);
  assert.equal(engine.status('g2').buffered, 0);

  observe(engine, 'g2', '乙');
  observe(engine, 'g2', '丙');
  engine.dispose('*');
  assert.equal(clock.pending(), 0);
  clock.advance(10_000);
  assert.equal(ambients.length, 0);
});

test('onAmbient 抛错不影响引擎：记录照常写入，后续消息仍可触发', () => {
  const clock = createClock();
  const { engine, ambients } = createEngine(
    clock,
    { silenceMs: 10, minMessages: 1, cooldownMs: 0, maxPerHour: 10, maxPerDay: 10 },
    {
      onAmbient() {
        throw new Error('上层回调故障');
      },
    },
  );

  observe(engine, 'g1', '甲');
  assert.doesNotThrow(() => clock.advance(10));
  assert.equal(ambients.length, 1, '回调已执行（虽然抛错）');
  assert.notEqual(engine.status('g1').lastAmbientAt, null);

  observe(engine, 'g1', '甲');
  assert.doesNotThrow(() => clock.advance(10));
  assert.equal(ambients.length, 2);
});

test('observe：缺少 chatId 抛 TypeError；非法 settings 回退默认值', () => {
  const clock = createClock();
  const ambient = [];
  const engine = new GroupTriggerEngine({
    settings: { silenceMs: -1 },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onAmbient: (chatId) => ambient.push(chatId),
    logger: { warn() {}, error() {} },
  });
  assert.equal(engine.settings, DEFAULT_GROUP_TRIGGER);
  assert.throws(() => engine.observe({ mentionedBot: false }), TypeError);
  assert.throws(() => engine.evaluate(''), TypeError);
});


test('连续对话窗口：@ 之后的未 @ 消息返回 followUp，窗口到期恢复 record', () => {
  const clock = createClock();
  const { engine } = createEngine(clock, {
    followUpMs: 60_000,
    followUpMaxReplies: 3,
    followUpMinIntervalMs: 5_000,
    minMessages: 99, // 避免静默定时器干扰断言
  });

  assert.equal(observe(engine, 'g1', '甲', { mentionedBot: true }), 'direct');
  clock.advance(6_000);
  assert.equal(observe(engine, 'g1', '甲'), 'followUp');
  clock.advance(2_000); // 未达到最小间隔
  assert.equal(observe(engine, 'g1', '甲'), 'record');
  clock.advance(5_000);
  assert.equal(observe(engine, 'g1', '乙'), 'followUp');
  clock.advance(5_000);
  assert.equal(observe(engine, 'g1', '乙'), 'followUp');
  clock.advance(5_000);
  assert.equal(observe(engine, 'g1', '丙'), 'record', '窗口内续聊上限用尽');
  clock.advance(60_000);
  assert.equal(observe(engine, 'g1', '丁'), 'record', '窗口过期');
});

test('连续对话窗口：followUpMs=0 表示关闭，@ 后仍返回 record', () => {
  const clock = createClock();
  const { engine } = createEngine(clock, { followUpMs: 0, minMessages: 99 });
  assert.equal(observe(engine, 'g1', '甲', { mentionedBot: true }), 'direct');
  clock.advance(1_000);
  assert.equal(observe(engine, 'g1', '甲'), 'record');
});

test('连续对话窗口：status 暴露剩余续聊额度', () => {
  const clock = createClock();
  const { engine } = createEngine(clock, {
    followUpMs: 60_000,
    followUpMaxReplies: 3,
    followUpMinIntervalMs: 0,
    minMessages: 99,
  });
  observe(engine, 'g1', '甲', { mentionedBot: true });
  clock.advance(1_000);
  observe(engine, 'g1', '甲');
  const status = engine.status('g1');
  assert.equal(status.followUp.active, true);
  assert.equal(status.followUp.remainingReplies, 2);
  clock.advance(120_000);
  assert.equal(engine.status('g1').followUp.active, false);
});
