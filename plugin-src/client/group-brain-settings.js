import * as React from 'react';
import { h, localizeTemplate } from './i18n.js';

export const GROUP_BRAIN_RPC_CHANNEL = '/dsh-im-settings';
export const GROUP_BRAIN_ENDPOINTS = Object.freeze({
  get: 'settings.group-brain.get',
  set: 'settings.group-brain.set',
  status: 'settings.group-brain.status',
  consolidate: 'settings.group-brain.consolidate',
  testWechatPersonal: 'settings.group-brain.wechat-personal.test',
  wechatPersonalPersonas: 'settings.group-brain.wechat-personal.personas',
});

const DEFAULT_BRAIN_TEMPLATE = Object.freeze({
  enabled: true,
  maxMembers: 5,
  allowedGroups: [],
  ambient: { enabled: true, silenceMs: 120_000, minMessages: 2, cooldownMs: 600_000, maxPerHour: 4, maxPerDay: 40, followUpMs: 300_000, followUpMaxReplies: 8, followUpMinIntervalMs: 3_000, mergeWindowMs: 30_000 },
  memory: { consolidateIntervalDays: 30, segmentGapMs: 600_000, maxMemoryChars: 16_000 },
  profiles: { enabled: true, maxProfiles: 5 },
  wechatPersonal: {
    enabled: false,
    daemonUrl: 'http://127.0.0.1:16174',
    tokenPath: '',
    accountId: '',
    personaId: 'dafeiyu-group',
  },
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
  const wechatPersonal = value.wechatPersonal ?? DEFAULT_BRAIN_TEMPLATE.wechatPersonal;
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
      followUpMs: ambient.followUpMs ?? DEFAULT_BRAIN_TEMPLATE.ambient.followUpMs,
      followUpMaxReplies: ambient.followUpMaxReplies ?? DEFAULT_BRAIN_TEMPLATE.ambient.followUpMaxReplies,
      followUpMinIntervalMs: ambient.followUpMinIntervalMs ?? DEFAULT_BRAIN_TEMPLATE.ambient.followUpMinIntervalMs,
      mergeWindowMs: ambient.mergeWindowMs ?? DEFAULT_BRAIN_TEMPLATE.ambient.mergeWindowMs,
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
    wechatPersonal: {
      enabled: wechatPersonal.enabled === true,
      daemonUrl: typeof wechatPersonal.daemonUrl === 'string' && wechatPersonal.daemonUrl
        ? wechatPersonal.daemonUrl : DEFAULT_BRAIN_TEMPLATE.wechatPersonal.daemonUrl,
      tokenPath: typeof wechatPersonal.tokenPath === 'string' ? wechatPersonal.tokenPath : '',
      accountId: typeof wechatPersonal.accountId === 'string' ? wechatPersonal.accountId : '',
      personaId: typeof wechatPersonal.personaId === 'string' && wechatPersonal.personaId
        ? wechatPersonal.personaId : DEFAULT_BRAIN_TEMPLATE.wechatPersonal.personaId,
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

function TextField({ id, label, help, value, placeholder, disabled, onChange }) {
  return h('label', { className: 'dim-botGeneralField', htmlFor: id },
    h('span', { className: 'dim-botGeneralTitle' }, label),
    h('input', {
      id,
      type: 'text',
      className: 'dim-textInput',
      value: String(value ?? ''),
      placeholder,
      disabled,
      onChange: (event) => onChange(event.target.value),
    }),
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
  const [personas, setPersonas] = React.useState(null);
  const [testing, setTesting] = React.useState(false);
  const [testNotice, setTestNotice] = React.useState('');
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
      try {
        const choices = unwrap(await rpcCall(GROUP_BRAIN_ENDPOINTS.wechatPersonalPersonas, {}), '无法读取人设列表。');
        if (mounted.current) setPersonas(Array.isArray(choices?.personas) ? choices.personas : []);
      } catch { /* 人设列表失败不阻塞主设置。 */ }
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
        wechatPersonal: draft.wechatPersonal,
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

  const testWechatPersonal = async () => {
    if (disabled || testing) return;
    setTesting(true); setTestNotice(''); setError(null);
    try {
      const result = unwrap(await rpcCall(GROUP_BRAIN_ENDPOINTS.testWechatPersonal, {}), '微信个人号连接测试失败。');
      if (mounted.current) {
        const account = result?.account ?? {};
        setTestNotice(account.authenticated
          ? localizeTemplate('daemon 正常，已登录 {user}（{connection}），可见会话 {threads} 个。', {
            user: account.ownUsername || account.id || '',
            connection: account.connection || '未知连接',
            threads: result.threads ?? 0,
          })
          : 'daemon 可达，但微信个人号尚未登录，请先在 agent-wechat 扫码。');
        await refreshStatus();
      }
    } catch (caught) {
      if (mounted.current) setError(caught.message);
    } finally {
      if (mounted.current) setTesting(false);
    }
  };

  const patchWechat = (update) => setDraft((current) => (current ? { ...current, wechatPersonal: { ...current.wechatPersonal, ...update } } : current));

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
            id: `${id}-follow-up`, label: '连续对话窗口', unit: '秒', value: seconds(draft.ambient.followUpMs), min: 0, max: 1800,
            help: '被 @ 后这段时间内，未 @ 的群消息也会自然接话；0 表示关闭。', disabled,
            onChange: (value) => patch({ ambient: { ...draft.ambient, followUpMs: milliseconds(value) } }),
          }),
          h(NumberField, {
            id: `${id}-follow-up-replies`, label: '窗口内续聊上限', value: draft.ambient.followUpMaxReplies, min: 0, max: 100,
            help: '一次 @ 引发的连续对话最多续聊几条；0 表示关闭。', disabled,
            onChange: (value) => patch({ ambient: { ...draft.ambient, followUpMaxReplies: value } }),
          }),
          h(NumberField, {
            id: `${id}-follow-up-interval`, label: '续聊最小间隔', unit: '秒', value: seconds(draft.ambient.followUpMinIntervalMs), min: 0, max: 300,
            help: '连续对话中最快多久回一句，避免刷屏；默认 3 秒。', disabled,
            onChange: (value) => patch({ ambient: { ...draft.ambient, followUpMinIntervalMs: milliseconds(value) } }),
          }),
          h(NumberField, {
            id: `${id}-merge-window`, label: '同成员合并窗口', unit: '秒', value: seconds(draft.ambient.mergeWindowMs), min: 0, max: 120,
            help: '同一成员在这段时间内的连续消息合并成一次回复；0 表示收到就回复。', disabled,
            onChange: (value) => patch({ ambient: { ...draft.ambient, mergeWindowMs: milliseconds(value) } }),
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
        h('legend', { className: 'dim-botGeneralTitle' }, '微信个人号（agent-wechat）'),
        h('p', { className: 'dim-botGeneralHelp' },
          '通过本机的 agent-wechat daemon 接入你自己的微信小号，让群聊大脑读取真实微信群消息并参与聊天。@ 消息会直接回复；未 @ 消息进入记忆与自动接话判断。人设与聊天记忆都使用本面板的设置。'),
        h(SwitchRow, {
          id: `${id}-wechat-personal`, label: '启用微信个人号接入', checked: draft.wechatPersonal.enabled, disabled: disabled || !draft.enabled,
          help: '需要本机 agent-wechat daemon 已启动，且微信小号已扫码登录。',
          onChange: (value) => patchWechat({ enabled: value }),
        }),
        h('div', { className: 'dim-botGeneralGrid' },
          h(TextField, {
            id: `${id}-wechat-url`, label: 'daemon 地址', value: draft.wechatPersonal.daemonUrl,
            placeholder: 'http://127.0.0.1:16174', disabled: disabled || !draft.wechatPersonal.enabled,
            help: 'agent-wechat serve 的监听地址。',
            onChange: (value) => patchWechat({ daemonUrl: value }),
          }),
          h(TextField, {
            id: `${id}-wechat-account`, label: '账号 ID', value: draft.wechatPersonal.accountId,
            placeholder: 'xiaohao', disabled: disabled || !draft.wechatPersonal.enabled,
            help: 'wx accounts create 时使用的账号 ID。',
            onChange: (value) => patchWechat({ accountId: value.trim() }),
          })),
        h(TextField, {
          id: `${id}-wechat-token`, label: 'token 文件路径', value: draft.wechatPersonal.tokenPath,
          placeholder: '/path/to/agent-wechat/aw-data/api-token', disabled: disabled || !draft.wechatPersonal.enabled,
          help: 'daemon 数据目录下的 api-token 文件；插件只读取、不写入。',
          onChange: (value) => patchWechat({ tokenPath: value.trim() }),
        }),
        h('label', { className: 'dim-botGeneralField', htmlFor: `${id}-wechat-persona` },
          h('span', { className: 'dim-botGeneralTitle' }, '群聊人设'),
          h('select', {
            id: `${id}-wechat-persona`,
            className: 'dim-textInput',
            value: draft.wechatPersonal.personaId,
            disabled: disabled || !draft.wechatPersonal.enabled,
            onChange: (event) => patchWechat({ personaId: event.target.value }),
          },
          (Array.isArray(personas) && personas.length > 0 ? personas : [{ id: 'dafeiyu-group', name: '大肥鱼（群聊版）' }])
            .map((persona) => h('option', { key: persona.id, value: persona.id }, persona.name || persona.id))),
          h('span', { className: 'dim-botGeneralHelp' }, '默认使用「大肥鱼（群聊版）」；也可以选择人设库里的其它条目。')),
        h('div', { className: 'dim-botGeneralActions' },
          h('button', { type: 'button', className: 'dim-deliveryButton', disabled: disabled || testing, onClick: testWechatPersonal },
            testing ? '正在测试…' : '测试 daemon 连接')),
        testNotice ? h('p', { role: 'status', className: 'dim-botGeneralHelp' }, testNotice) : null,
        status?.wechatPersonal
          ? h('p', { className: 'dim-botGeneralHelp' },
            status.wechatPersonal.running
              ? localizeTemplate('运行中：{user}（{groups} 个群）', {
                user: status.wechatPersonal.account?.ownUserId ?? '',
                groups: status.wechatPersonal.runtime?.groups?.length ?? 0,
              })
              : status.wechatPersonal.lastError
                ? localizeTemplate('未运行：{error}', { error: status.wechatPersonal.lastError })
                : '未运行')
          : null),

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
