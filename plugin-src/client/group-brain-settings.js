import * as React from 'react';
import { h, localizeTemplate } from './i18n.js';

export const GROUP_BRAIN_RPC_CHANNEL = '/dsh-im-settings';
export const GROUP_BRAIN_ENDPOINTS = Object.freeze({
  get: 'settings.group-brain.get',
  set: 'settings.group-brain.set',
  status: 'settings.group-brain.status',
  consolidate: 'settings.group-brain.consolidate',
});

const DEFAULT_BRAIN_TEMPLATE = Object.freeze({
  enabled: true,
  maxMembers: 5,
  allowedGroups: [],
  ambient: { enabled: true, silenceMs: 120_000, minMessages: 2, cooldownMs: 600_000, maxPerHour: 4, maxPerDay: 40 },
  memory: { consolidateIntervalDays: 30, segmentGapMs: 600_000, maxMemoryChars: 16_000 },
  profiles: { enabled: true, maxProfiles: 5 },
});

function unwrap(result, fallbackMessage) {
  if (result?.ok === false) throw new Error(result.error?.message || fallbackMessage);
  return result?.ok === true ? result.value : result;
}

function normalizeSettings(value) {
  if (!value || typeof value !== 'object') throw new Error('群聊大脑设置返回了无法识别的响应。');
  const ambient = value.ambient ?? DEFAULT_BRAIN_TEMPLATE.ambient;
  const memory = value.memory ?? DEFAULT_BRAIN_TEMPLATE.memory;
  const profiles = value.profiles ?? DEFAULT_BRAIN_TEMPLATE.profiles;
  return {
    enabled: value.enabled === true,
    maxMembers: Number.isInteger(value.maxMembers) ? value.maxMembers : DEFAULT_BRAIN_TEMPLATE.maxMembers,
    allowedGroups: Array.isArray(value.allowedGroups) ? value.allowedGroups : [],
    ambient: {
      enabled: ambient.enabled === true,
      silenceMs: ambient.silenceMs ?? DEFAULT_BRAIN_TEMPLATE.ambient.silenceMs,
      minMessages: ambient.minMessages ?? DEFAULT_BRAIN_TEMPLATE.ambient.minMessages,
      cooldownMs: ambient.cooldownMs ?? DEFAULT_BRAIN_TEMPLATE.ambient.cooldownMs,
      maxPerHour: ambient.maxPerHour ?? DEFAULT_BRAIN_TEMPLATE.ambient.maxPerHour,
      maxPerDay: ambient.maxPerDay ?? DEFAULT_BRAIN_TEMPLATE.ambient.maxPerDay,
    },
    memory: {
      consolidateIntervalDays: memory.consolidateIntervalDays ?? DEFAULT_BRAIN_TEMPLATE.memory.consolidateIntervalDays,
      segmentGapMs: memory.segmentGapMs ?? DEFAULT_BRAIN_TEMPLATE.memory.segmentGapMs,
      maxMemoryChars: memory.maxMemoryChars ?? DEFAULT_BRAIN_TEMPLATE.memory.maxMemoryChars,
    },
    profiles: {
      enabled: profiles.enabled === true,
      maxProfiles: profiles.maxProfiles ?? DEFAULT_BRAIN_TEMPLATE.profiles.maxProfiles,
    },
  };
}

function allowedGroupsText(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => [group.channel, group.botId, group.chatId, group.groupName].filter((part) => typeof part === 'string' && part).join(':'))
    .join('\n');
}

function parseAllowedGroups(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [channel = '', botId = '', chatId = '', ...rest] = line.split(':');
      return { channel: channel.trim(), botId: botId.trim(), chatId: chatId.trim(), groupName: rest.join(':').trim() };
    })
    .filter((group) => group.channel && group.botId && group.chatId);
}

function seconds(value) { return Math.round(value / 1000); }
function milliseconds(value) { return Math.round(value) * 1000; }
function minutes(value) { return Math.round(value / 60_000); }
function fromMinutes(value) { return Math.round(value) * 60_000; }

function NumberField({ id, label, help, value, min, max, step = 1, unit, onChange }) {
  return h('label', { className: 'dim-botGeneralField', htmlFor: id },
    h('span', { className: 'dim-botGeneralTitle' }, label),
    h('input', {
      id,
      type: 'number',
      className: 'dim-textInput',
      min,
      max,
      step,
      value: String(value),
      onChange: (event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      },
    }),
    unit ? h('span', { className: 'dim-botGeneralHelp' }, unit) : null,
    help ? h('span', { className: 'dim-botGeneralHelp' }, help) : null);
}

function SwitchRow({ id, label, help, checked, disabled, onChange }) {
  return h('div', { className: 'dim-botGeneralRow' },
    h('div', { className: 'dim-botGeneralText' },
      h('div', { className: 'dim-sidebarHeading' }, h('label', { className: 'dim-botGeneralTitle', htmlFor: id }, label)),
      h('p', { className: 'dim-botGeneralHelp' }, help)),
    h('div', { className: 'dim-botGeneralControl' },
      h('label', { className: 'dim-contextSwitchRow' },
        h('span', { className: 'dim-botGeneralHelp' }, checked ? '已开启' : '已关闭'),
        h('input', {
          id,
          type: 'checkbox',
          role: 'switch',
          className: 'dim-contextSwitch',
          checked,
          disabled,
          onChange: (event) => onChange(event.target.checked),
        }))));
}

function groupCounts(status) {
  const brains = Array.isArray(status?.brains) ? status.brains : [];
  return brains.map((brain) => {
    const groups = Array.isArray(brain?.status?.groups) ? brain.status.groups : [];
    return {
      channel: brain?.channel ?? 'qq',
      botId: brain?.botId ?? '',
      groups: groups.length,
      pending: groups.filter((group) => group?.nextConsolidateAt).length,
    };
  });
}

/**
 * 群聊大脑设置：小群主动接话、长期记忆、成员画像与白名单。
 * 状态来自 Host 进程内已注册的 brain；保存后热更新，无需重连机器人。
 */
export function GroupBrainSettings({ rpcCall }) {
  const [settings, setSettings] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [saved, setSaved] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const mounted = React.useRef(false);
  const busy = React.useRef(false);
  const id = React.useId();
  const disabled = phase === 'loading' || phase === 'saving';

  const load = React.useCallback(async (signal) => {
    setPhase('loading'); setError(null); setSaved(false); setNotice('');
    try {
      const [nextSettings, nextStatus] = await Promise.all([
        rpcCall(GROUP_BRAIN_ENDPOINTS.get, {}, signal).then((result) => normalizeSettings(unwrap(result, '无法读取群聊大脑设置，请稍后重试。'))),
        rpcCall(GROUP_BRAIN_ENDPOINTS.status, {}, signal).then((result) => unwrap(result, '无法读取群聊大脑状态，请稍后重试。')).catch(() => null),
      ]);
      if (signal?.aborted || !mounted.current) return;
      setSettings(nextSettings); setDraft(nextSettings); setStatus(nextStatus); setPhase('ready');
    } catch (caught) {
      if (signal?.aborted || !mounted.current) return;
      setError(caught.message); setPhase('error');
    }
  }, [rpcCall]);

  React.useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void load(abort.signal);
    return () => { mounted.current = false; abort.abort(); };
  }, [load]);

  const patch = (update) => setDraft((current) => (current ? { ...current, ...update } : current));

  const save = async () => {
    if (busy.current || disabled || !draft) return;
    busy.current = true; setPhase('saving'); setError(null); setSaved(false); setNotice('');
    try {
      const result = await rpcCall(GROUP_BRAIN_ENDPOINTS.set, {
        enabled: draft.enabled,
        maxMembers: draft.maxMembers,
        allowedGroups: draft.allowedGroups,
        ambient: draft.ambient,
        memory: draft.memory,
        profiles: draft.profiles,
      });
      const next = normalizeSettings(unwrap(result, '无法保存群聊大脑设置，请稍后重试。'));
      if (mounted.current) { setSettings(next); setDraft(next); setSaved(true); setPhase('ready'); }
    } catch (caught) {
      if (mounted.current) { setError(caught.message); setPhase('error'); }
    } finally { busy.current = false; }
  };

  const refreshStatus = async () => {
    if (disabled) return;
    setNotice('');
    try {
      const next = unwrap(await rpcCall(GROUP_BRAIN_ENDPOINTS.status, {}), '无法读取群聊大脑状态，请稍后重试。');
      if (mounted.current) { setStatus(next); setNotice('已刷新运行状态。'); }
    } catch (caught) {
      if (mounted.current) setError(caught.message);
    }
  };

  const consolidate = async () => {
    if (disabled) return;
    setNotice('');
    try {
      unwrap(await rpcCall(GROUP_BRAIN_ENDPOINTS.consolidate, {}, undefined), '无法触发记忆整理，请稍后重试。');
      if (mounted.current) { setNotice('已触发记忆整理，稍后可刷新状态查看结果。'); await refreshStatus(); }
    } catch (caught) {
      if (mounted.current) setError(caught.message);
    }
  };

  const dirty = Boolean(settings && draft && JSON.stringify(settings) !== JSON.stringify(draft));
  const groups = groupCounts(status);
  const draftGroups = draft?.allowedGroups ?? [];

  return h('section', { className: 'dim-botGeneralSettings dim-groupBrainSettings', 'aria-label': '群聊大脑', 'aria-busy': disabled },
    h('div', { className: 'dim-sidebarHeading' },
      h('div', { className: 'dim-botGeneralTitle' }, '群聊大脑'),
      h('span', { role: 'status', className: 'dim-botGeneralHelp' },
        phase === 'loading' ? '正在读取群聊大脑设置…'
          : phase === 'saving' ? '保存中…'
            : saved ? '已保存' : '')),
    h('p', { className: 'dim-botGeneralHelp' },
      '为小群提供主动接话、永久群记忆与成员画像。开启后，群内未 @ 机器人的消息也会进入记忆与话题判断；自动接话默认只对白名单群或已知 ≤5 人的小群生效。'),

    draft ? h(React.Fragment, null,
      h(SwitchRow, {
        id: `${id}-enabled`, label: '启用群聊大脑', checked: draft.enabled, disabled,
        help: '关闭后不再记录群消息、不自动接话，也不会生成长期记忆。',
        onChange: (value) => patch({ enabled: value }),
      }),
      h(SwitchRow, {
        id: `${id}-ambient`, label: '自动接话', checked: draft.ambient.enabled, disabled: disabled || !draft.enabled,
        help: '一段讨论结束后，根据话题自然接一句；不适合时会保持沉默。',
        onChange: (value) => patch({ ambient: { ...draft.ambient, enabled: value } }),
      }),
      h('div', { className: 'dim-botGeneralRow dim-botGeneralRowStacked' },
        h('div', { className: 'dim-botGeneralText' },
          h('div', { className: 'dim-botGeneralTitle' }, '自动接话白名单'),
          h('p', { className: 'dim-botGeneralHelp' },
            '每行一个群，格式：渠道:机器人ID:群ID:群名（群名可省略）。留空表示只对已知 ≤5 人的小群生效。')),
        h('textarea', {
          className: 'dim-textInput dim-groupBrainGroups',
          rows: 4,
          value: allowedGroupsText(draftGroups),
          disabled,
          'aria-label': '自动接话白名单',
          onChange: (event) => patch({ allowedGroups: parseAllowedGroups(event.target.value) }),
        })),

      h('fieldset', { className: 'dim-botGeneralFieldset' },
        h('legend', { className: 'dim-botGeneralTitle' }, '接话节奏'),
        h('div', { className: 'dim-botGeneralGrid' },
          h(NumberField, {
            id: `${id}-silence`, label: '讨论静默', unit: '秒', value: seconds(draft.ambient.silenceMs), min: 30, max: 3600,
            help: '群内安静这么久后认为一段讨论结束。', disabled,
            onChange: (value) => patch({ ambient: { ...draft.ambient, silenceMs: milliseconds(value) } }),
          }),
          h(NumberField, {
            id: `${id}-min`, label: '最少消息数', value: draft.ambient.minMessages, min: 1, max: 50,
            help: '一段讨论少于这么多条消息时不接话。', disabled,
            onChange: (value) => patch({ ambient: { ...draft.ambient, minMessages: value } }),
          }),
          h(NumberField, {
            id: `${id}-cooldown`, label: '接话冷却', unit: '分钟', value: minutes(draft.ambient.cooldownMs), min: 1, max: 1440,
            help: '两次自动接话之间的最短间隔。', disabled,
            onChange: (value) => patch({ ambient: { ...draft.ambient, cooldownMs: fromMinutes(value) } }),
          }),
          h(NumberField, {
            id: `${id}-per-hour`, label: '每小时上限', value: draft.ambient.maxPerHour, min: 1, max: 30,
            help: '每小时最多主动发言次数。', disabled,
            onChange: (value) => patch({ ambient: { ...draft.ambient, maxPerHour: value } }),
          }),
          h(NumberField, {
            id: `${id}-per-day`, label: '每日上限', value: draft.ambient.maxPerDay, min: 1, max: 300,
            help: '每天最多主动发言次数。', disabled,
            onChange: (value) => patch({ ambient: { ...draft.ambient, maxPerDay: value } }),
          }))),

      h(SwitchRow, {
        id: `${id}-profiles`, label: '成员画像', checked: draft.profiles.enabled, disabled: disabled || !draft.enabled,
        help: '为群成员记录称呼、兴趣与说话风格；回复特定成员时参考其画像。',
        onChange: (value) => patch({ profiles: { ...draft.profiles, enabled: value } }),
      }),
      h('div', { className: 'dim-botGeneralGrid' },
        h(NumberField, {
          id: `${id}-max-members`, label: '小群人数上限', value: draft.maxMembers, min: 2, max: 50,
          help: '无法获知群成员数时，自动接话只对白名单群生效。', disabled,
          onChange: (value) => patch({ maxMembers: value }),
        }),
        h(NumberField, {
          id: `${id}-max-profiles`, label: '画像上限', value: draft.profiles.maxProfiles, min: 1, max: 20,
          help: '每个群最多保留的成员画像数量。', disabled,
          onChange: (value) => patch({ profiles: { ...draft.profiles, maxProfiles: value } }),
        })),

      h('fieldset', { className: 'dim-botGeneralFieldset' },
        h('legend', { className: 'dim-botGeneralTitle' }, '长期记忆'),
        h('p', { className: 'dim-botGeneralHelp' },
          '原始群消息永久保存在本机；按固定间隔压缩为长期记忆与成员画像，避免文件无限增长。'),
        h('div', { className: 'dim-botGeneralGrid' },
          h(NumberField, {
            id: `${id}-interval`, label: '整理间隔', unit: '天', value: draft.memory.consolidateIntervalDays, min: 1, max: 365,
            help: '每隔这么久把新增群消息整理进长期记忆。', disabled,
            onChange: (value) => patch({ memory: { ...draft.memory, consolidateIntervalDays: value } }),
          }),
          h(NumberField, {
            id: `${id}-memory-chars`, label: '记忆上限', unit: '字符', value: draft.memory.maxMemoryChars, min: 2000, max: 64000, step: 1000,
            help: '长期记忆文件保留的最大字符数，超出时保留最近内容。', disabled,
            onChange: (value) => patch({ memory: { ...draft.memory, maxMemoryChars: value } }),
          }))),

      h('div', { className: 'dim-botGeneralActions' },
        h('button', { type: 'button', className: 'dim-deliveryButton', disabled: disabled || !dirty, onClick: save }, dirty ? '保存群聊大脑设置' : '设置已保存'),
        h('button', { type: 'button', className: 'dim-deliveryButton', disabled, onClick: refreshStatus }, '刷新运行状态'),
        h('button', { type: 'button', className: 'dim-deliveryButton', disabled, onClick: consolidate }, '立即整理记忆')),

      groups.length > 0
        ? h('ul', { className: 'dim-groupBrainStatus' },
          groups.map((group) => h('li', { key: `${group.channel}:${group.botId}` },
            localizeTemplate('{channel} · {botId}：{groups} 个群，{pending} 个群待整理', group))))
        : h('p', { className: 'dim-botGeneralHelp' }, '暂无运行中的群聊大脑；机器人连接后会显示运行状态。'),
      notice ? h('p', { role: 'status', className: 'dim-botGeneralHelp' }, notice) : null)
      : null,

    error ? h('div', { className: 'dim-sidebarFeedback' },
      h('p', { role: 'alert', className: 'dim-accessFeedback', 'data-tone': 'error' }, error),
      h('button', { type: 'button', className: 'dim-deliveryButton', onClick: () => load() }, '重试'))
      : null);
}
