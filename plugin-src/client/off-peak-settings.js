import * as React from 'react';
import { h, localizeTemplate } from './i18n.js';

export const OFF_PEAK_RPC_CHANNEL = '/dsh-im-settings';
export const OFF_PEAK_ENDPOINTS = Object.freeze({
  get: 'settings.off-peak.get',
  set: 'settings.off-peak.set',
  syncHolidays: 'settings.off-peak.sync-holidays',
});

function statusResult(result) {
  if (result?.ok === false) {
    throw new Error(result.error?.message || '无法读取或保存闲时启用设置，请稍后重试。');
  }
  const value = result?.ok === true ? result.value : result;
  if (typeof value?.enabled !== 'boolean'
    || typeof value.offPeakNow !== 'boolean'
    || typeof value.activeNow !== 'boolean') {
    throw new Error('闲时启用设置返回了无法识别的响应。');
  }
  return value;
}

function detailText(value) {
  if (!value) return null;
  if (!value.enabled) return '已关闭，机器人始终响应消息。';
  return value.offPeakNow
    ? '已开启，当前为空闲时段（半价），机器人正常响应。'
    : '已开启，当前为高峰时段，不调用模型，仅自动回复固定提示以节省 API 费用。';
}

function peakWindowsText(value) {
  const windows = value?.schedule?.peakWindows;
  if (!Array.isArray(windows) || windows.length === 0) {
    return localizeTemplate('高峰时段：北京时间周一至周五 {windows}（中国法定节假日除外）', {
      windows: '09:00–12:00、14:00–18:00',
    });
  }
  return localizeTemplate('高峰时段：北京时间周一至周五 {windows}（中国法定节假日除外）', {
    windows: windows.map(({ start, end }) => `${start}–${end}`).join('、'),
  });
}

function holidayTableText(value) {
  const schedule = value?.schedule ?? {};
  const years = Array.isArray(schedule.builtinHolidayYears)
    ? schedule.builtinHolidayYears.join('、')
    : '2026、2027';
  const syncedAt = schedule.syncedAt;
  if (typeof syncedAt === 'string' && syncedAt) {
    const time = new Date(syncedAt);
    const label = Number.isNaN(time.getTime()) ? syncedAt : time.toLocaleString();
    return localizeTemplate('已同步 {count} 个节假日（最近同步：{time}）', {
      count: Array.isArray(schedule.syncedHolidays) ? schedule.syncedHolidays.length : 0,
      time: label,
    });
  }
  return localizeTemplate('尚未同步节假日；当前使用内置 {years} 年节假日表。', {
    years,
  });
}

/**
 * 全局闲时启用开关：微信与 QQ 共用。开启后 DeepSeek 高峰时段宿主静默丢弃
 * 入站消息（不调用 API、不回复），空闲时段恢复响应。
 */
export function OffPeakSettings({ rpcCall }) {
  const [value, setValue] = React.useState(null);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [saved, setSaved] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [syncNotice, setSyncNotice] = React.useState(null);
  const mounted = React.useRef(false);
  const busy = React.useRef(false);
  const failedValue = React.useRef(null);
  const id = React.useId();
  const disabled = phase === 'loading' || phase === 'saving' || syncing;

  const applyValue = React.useCallback((next) => {
    setValue(next);
  }, []);

  const load = React.useCallback(async (signal) => {
    setPhase('loading'); setError(null); setSaved(false);
    failedValue.current = null;
    try {
      const next = statusResult(await rpcCall(OFF_PEAK_ENDPOINTS.get, {}, signal));
      if (signal?.aborted || !mounted.current) return;
      applyValue(next); setPhase('ready');
    } catch (caught) {
      if (signal?.aborted || !mounted.current) return;
      setError(caught.message); setPhase('error');
    }
  }, [rpcCall, applyValue]);

  React.useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void load(abort.signal);
    return () => { mounted.current = false; abort.abort(); };
  }, [load]);

  const submit = async (payload, previous) => {
    if (busy.current || disabled) return;
    busy.current = true; setPhase('saving'); setError(null); setSaved(false);
    failedValue.current = null;
    try {
      const next = statusResult(await rpcCall(OFF_PEAK_ENDPOINTS.set, payload));
      if (mounted.current) { applyValue(next); setSaved(true); setPhase('ready'); }
    } catch (caught) {
      if (mounted.current) {
        failedValue.current = { payload, previous };
        if (previous) setValue(previous);
        setError(caught.message); setPhase('error');
      }
    } finally { busy.current = false; }
  };

  const saveToggle = (enabled) => {
    const previous = value;
    if (previous) setValue({ ...previous, enabled });
    void submit({ enabled }, previous);
  };

  const syncHolidays = async () => {
    if (syncing || phase === 'loading' || phase === 'saving') return;
    setSyncing(true);
    setSyncNotice(null);
    try {
      const next = statusResult(await rpcCall(OFF_PEAK_ENDPOINTS.syncHolidays, {}));
      if (!mounted.current) return;
      applyValue(next);
      setSyncNotice({ tone: 'success', text: holidayTableText(next) });
    } catch (caught) {
      if (!mounted.current) return;
      setSyncNotice({ tone: 'error', text: caught.message });
    } finally {
      if (mounted.current) setSyncing(false);
    }
  };

  return h('section', {
    className: 'dim-botGeneralSettings dim-offPeakSettings',
    'aria-label': '闲时启用',
    'aria-busy': disabled,
  },
  h('div', { className: 'dim-botGeneralRow' },
    h('div', { className: 'dim-botGeneralText' },
      h('div', { className: 'dim-sidebarHeading' },
        h('label', { className: 'dim-botGeneralTitle', htmlFor: id }, '闲时启用'),
        h('span', { role: 'status', className: 'dim-botGeneralHelp' },
          phase === 'loading' ? '正在读取闲时启用设置…'
            : phase === 'saving' ? '保存中…'
              : saved ? '已保存' : '')),
      h('p', { className: 'dim-botGeneralHelp', id: `${id}-help` },
        '开启后仅在 DeepSeek API 空闲时段响应消息；高峰时段不调用模型，只自动回复一条固定提示，以节省费用。'),
      value ? h('p', { className: 'dim-botGeneralHelp', 'data-tone': value.enabled && !value.offPeakNow ? 'warning' : undefined },
        detailText(value)) : null,
      h('p', { className: 'dim-botGeneralHelp' }, peakWindowsText(value)),
      h('p', { className: 'dim-botGeneralHelp' },
        '其余时间（工作日窗口外、周末、法定节假日全天，含调休上班的周末）为空闲时段，价格减半。')),
    h('div', { className: 'dim-botGeneralControl' },
      h('label', { className: 'dim-contextSwitchRow' },
        h('span', { className: 'dim-botGeneralHelp' }, value?.enabled ? '已开启' : '已关闭'),
        h('input', {
          id,
          type: 'checkbox',
          role: 'switch',
          className: 'dim-contextSwitch',
          checked: value?.enabled === true,
          disabled,
          'aria-describedby': `${id}-help`,
          onChange: (event) => saveToggle(event.target.checked),
        })))),
  h('div', { className: 'dim-offPeakHolidays' },
    h('div', { className: 'dim-sidebarHeading' },
      h('span', { className: 'dim-botGeneralTitle' }, '法定节假日表'),
      h('button', {
        type: 'button',
        className: 'dim-deliveryButton',
        disabled,
        onClick: () => { void syncHolidays(); },
      }, syncing ? '同步中…' : '同步节假日')),
    h('p', { className: 'dim-botGeneralHelp' },
      '内置 2026、2027 年中国法定节假日；点击按钮从 holiday-cn 手动同步最新国务院节假日安排（需要联网）。'),
    value ? h('p', { className: 'dim-botGeneralHelp' }, holidayTableText(value)) : null,
    syncNotice ? h('p', {
      role: syncNotice.tone === 'error' ? 'alert' : 'status',
      className: 'dim-accessFeedback',
      'data-tone': syncNotice.tone === 'error' ? 'error' : undefined,
    }, syncNotice.text) : null),
  error ? h('div', { className: 'dim-sidebarFeedback' },
    h('p', { role: 'alert', className: 'dim-accessFeedback', 'data-tone': 'error' }, error),
    h('button', {
      type: 'button',
      className: 'dim-deliveryButton',
      onClick: () => {
        const failed = failedValue.current;
        if (!failed) { load(); return; }
        saveToggle(failed.payload?.enabled === true);
      },
    }, '重试')) : null);
}
