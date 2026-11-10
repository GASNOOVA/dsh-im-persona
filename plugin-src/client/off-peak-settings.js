import * as React from 'react';
import { h } from './i18n.js';

export const OFF_PEAK_RPC_CHANNEL = '/dsh-im-settings';
export const OFF_PEAK_ENDPOINTS = Object.freeze({
  get: 'settings.off-peak.get', set: 'settings.off-peak.set',
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
    ? '已开启，当前为非高峰时段，机器人正常响应。'
    : '已开启，当前为高峰时段，入站消息将被静默丢弃，以节省 API 费用。';
}

/**
 * 全局闲时启用开关：微信与 QQ 共用。开启后 DeepSeek 高峰时段宿主静默丢弃
 * 入站消息（不调用 API、不回复），非高峰时段恢复响应。
 */
export function OffPeakSettings({ rpcCall }) {
  const [value, setValue] = React.useState(null);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [saved, setSaved] = React.useState(false);
  const mounted = React.useRef(false);
  const busy = React.useRef(false);
  const failedValue = React.useRef(null);
  const id = React.useId();
  const disabled = phase === 'loading' || phase === 'saving';

  const load = React.useCallback(async (signal) => {
    setPhase('loading'); setError(null); setSaved(false);
    failedValue.current = null;
    try {
      const next = statusResult(await rpcCall(OFF_PEAK_ENDPOINTS.get, {}, signal));
      if (signal?.aborted || !mounted.current) return;
      setValue(next); setPhase('ready');
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

  const save = async (enabled) => {
    if (busy.current || disabled) return;
    const previous = value;
    busy.current = true; setPhase('saving'); setError(null); setSaved(false);
    failedValue.current = null;
    setValue(previous ? { ...previous, enabled } : previous);
    try {
      const next = statusResult(await rpcCall(OFF_PEAK_ENDPOINTS.set, { enabled }));
      if (mounted.current) { setValue(next); setSaved(true); setPhase('ready'); }
    } catch (caught) {
      if (mounted.current) {
        failedValue.current = enabled;
        setValue(previous); setError(caught.message); setPhase('error');
      }
    } finally { busy.current = false; }
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
        '开启后仅在 DeepSeek API 非高峰时段响应消息；高峰时段静默丢弃入站消息，不调用 API，以节省费用。'),
      value ? h('p', { className: 'dim-botGeneralHelp', 'data-tone': value.enabled && !value.offPeakNow ? 'warning' : undefined },
        detailText(value)) : null,
      h('p', { className: 'dim-botGeneralHelp' },
        '非高峰时段：UTC 16:30–次日 00:30（北京时间 00:30–08:30）')),
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
          onChange: (event) => save(event.target.checked),
        })))),
  error ? h('div', { className: 'dim-sidebarFeedback' },
    h('p', { role: 'alert', className: 'dim-accessFeedback', 'data-tone': 'error' }, error),
    h('button', {
      type: 'button',
      className: 'dim-deliveryButton',
      onClick: () => failedValue.current === null ? load() : save(failedValue.current),
    }, '重试')) : null);
}
