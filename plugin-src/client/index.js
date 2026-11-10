import { callManagementRpc } from '../management-rpc.mjs';
import { PERSONA_RPC_CHANNEL } from '../../src/channels/shared/persona.mjs';
import * as React from 'react';
import manifest from '../../package.json' with { type: 'json' };

import { WeixinLogoGlyph, QqLogoGlyph } from './channel-logos.js';
import { QQ_RPC_CHANNEL } from './channels/qq/api.js';
import { QqSettingsTab } from './channels/qq/index.js';
import { installQqStyles } from './channels/qq/styles.js';
import { WeixinSettingsTab } from './channels/weixin/index.js';
import { WEIXIN_RPC_CHANNEL } from './channels/weixin/api.js';
import { installWeixinStyles } from './channels/weixin/styles.js';
import { installBotSettingsStyles } from './channels/shared/bot-settings-styles.js';
import { en, h, IM_LOCALE_NAMESPACE, installImRussianLocale, setImTranslator, zh } from './i18n.js';
import {
  HOST_LANGUAGE_RPC_CHANNEL,
  installInterfaceLanguageMirror,
} from './interface-language.js';
import { BotSettingsContext } from './channel-card-meta.js';
import {
  DELIVERY_RPC_CHANNEL,
  DeliveryTargetSettingsPage,
} from './delivery-settings.js';
import {
  GLOBAL_SETTINGS_RPC_CHANNEL,
  GLOBAL_SETTINGS_TAB_ID,
  GlobalSettingsLogoGlyph,
  GlobalSettingsPanel,
} from './global-settings.js';
import {
  createLoopbackAwareRpcCalls,
  replacePageLocation,
} from './loopback-recovery.js';
import { installImStyles } from './styles.js';
import { DELIVERY_SYNC_SETTINGS_RPC_CHANNEL } from './delivery-sync-settings.js';
import { installSessionChannelLogos } from './session-channel-logos.js';
import { installDsBotSessionAvatars } from './ds-bot-session-avatars.js';
import { WorkspaceDirectoryPickerContext } from './workspace-editor.js';
import { IMPanelErrorBoundary } from './panel-error-boundary.js';
import { installImPluginPage } from './plugin-page.js';
import { installSidebarVisibilitySync, SIDEBAR_SETTINGS_ENDPOINTS, SIDEBAR_SETTINGS_RPC_CHANNEL } from './sidebar-settings.js';

import { installChannelSessionsPage, CHANNEL_LIST_RPC_CHANNEL } from './im-channels.js';
export const name = 'im-persona-settings';
export const inject = ['slots', 'connection', 'locale', 'workspaces'];
export const IM_PLUGIN_VERSION = manifest.version;

function callWorkspaceDirectoryApi(ctx, method, ...args) {
  // Current DSH owns directory operations on uiWorkspace; legacy Hosts keep them on workspaces.
  const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
  const service = typeof uiWorkspace?.[method] === 'function' ? uiWorkspace : ctx.workspaces;
  if (typeof service?.[method] !== 'function') {
    throw new Error('无法读取目录，请重试。');
  }
  return service[method](...args);
}

// Personal edition: only Weixin (微信) and QQ remain, in that order.
const CHANNELS = Object.freeze([
  { id: 'weixin', label: '微信' },
  { id: 'qq', label: 'QQ' },
]);

function WeixinLogo() {
  return h('span', { className: 'dim-logo dim-logoWeixin', 'aria-hidden': 'true' },
    h(WeixinLogoGlyph));
}

function QqLogo() {
  return h('span', { className: 'dim-logo dim-logoQq', 'aria-hidden': 'true' }, h(QqLogoGlyph));
}

function ChannelLogo({ channel }) {
  if (channel === 'weixin') return h(WeixinLogo);
  if (channel === 'qq') return h(QqLogo);
  return null;
}

export function LoopbackRecoveryNotice({ recovery, onNavigate = replacePageLocation }) {
  return h('div', {
    className: 'dim-loopbackRecovery',
    role: 'alert',
  },
  h('div', { className: 'dim-loopbackRecoveryCopy' },
    h('strong', null, '请改用 localhost 重新打开'),
    h('p', null, '页面会在当前端口重新打开，机器人配置不会改变。'),
    h('code', null, recovery.origin)),
  h('button', {
    type: 'button',
    className: 'dim-loopbackRecoveryAction',
    onClick: () => onNavigate(recovery.url),
  }, '使用 localhost 重新打开'));
}

export function IMSettingsTab({
  qqRpcCall,
  weixinRpcCall,
  personaRpcCall,
  deliveryRpcCall,
  globalSettingsRpcCall,
  deliverySyncRpcCall,
  languageRpcCall,
  workspaceDirectoryPicker,
  onOpenSessionHistory,
  preferredSectionId,
  browserLocation = globalThis.location,
  navigateToRecoveryUrl = replacePageLocation,
}) {
  const [selected, setSelected] = React.useState(() => (
    preferredSectionId === GLOBAL_SETTINGS_TAB_ID
      || CHANNELS.some((channel) => channel.id === preferredSectionId)
      ? preferredSectionId : 'weixin'
  ));
  const [loopbackRecovery, setLoopbackRecovery] = React.useState(null);
  const [deliverySettings, setDeliverySettings] = React.useState(null);
  const visibleChannels = CHANNELS;
  const githubTooltipId = React.useId();
  const sessionHistoryTooltipId = React.useId();
  const generalSettingsTooltipId = React.useId();
  const globalSettingsSelected = selected === GLOBAL_SETTINGS_TAB_ID;
  const active = visibleChannels.find((channel) => channel.id === selected) ?? visibleChannels[0];
  const activeTabId = globalSettingsSelected
    ? 'dim-general-settings-trigger'
    : `dim-tab-${active.id}`;
  const activePanelId = globalSettingsSelected
    ? `dim-panel-${GLOBAL_SETTINGS_TAB_ID}`
    : `dim-panel-${active.id}`;
  const reportLoopbackRecovery = React.useCallback((recovery) => {
    setLoopbackRecovery((current) => current?.url === recovery.url ? current : recovery);
  }, []);
  const rpcCalls = React.useMemo(() => createLoopbackAwareRpcCalls({
    qqRpcCall,
    weixinRpcCall,
    personaRpcCall,
    deliveryRpcCall,
    globalSettingsRpcCall,
    deliverySyncRpcCall,
    languageRpcCall,
  }, {
    location: browserLocation,
    onRecovery: reportLoopbackRecovery,
  }), [
    browserLocation,
    deliveryRpcCall,
    globalSettingsRpcCall,
    deliverySyncRpcCall,
    languageRpcCall,
    personaRpcCall,
    qqRpcCall,
    reportLoopbackRecovery,
    weixinRpcCall,
  ]);
  const botSettingsContext = React.useMemo(() => Object.freeze({
    openBotSettings: setDeliverySettings,
  }), []);
  return h(WorkspaceDirectoryPickerContext.Provider, { value: workspaceDirectoryPicker },
    h('section', { className: 'dim-page', 'aria-label': 'IM机器人设置' },
    h('header', { className: 'dim-title' },
      h('div', { className: 'dim-brand' },
        h('div', { className: 'dim-brandHeading' },
          h('strong', { className: 'dim-brandName' }, 'DSH-IM Persona'),
          h('span', { className: 'dim-brandVersion' }, `v${IM_PLUGIN_VERSION}`)),
        h('p', null, '微信 / QQ · 个人定制版')),
      h('div', { className: 'dim-titleActions' },
      h('span', { className: 'dim-githubAction' },
        h('a', {
          className: 'dim-githubLink',
          href: 'https://github.com/GASNOOVA/dsh-im-persona',
          target: '_blank',
          rel: 'noopener noreferrer',
          'aria-label': 'dsh-im-persona GitHub',
          'aria-describedby': githubTooltipId,
        },
        h('svg', {
          width: 18,
          height: 18,
          viewBox: '0 0 16 16',
          fill: 'currentColor',
          focusable: 'false',
          'aria-hidden': 'true',
        }, h('path', {
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
        }))),
        h('span', {
          id: githubTooltipId,
          className: 'dim-githubTooltip',
          role: 'tooltip',
        }, '帮助与反馈 · 前往个人版仓库')),
      onOpenSessionHistory ? h('span', { className: 'dim-sessionHistoryAction' },
        h('button', {
          type: 'button',
          className: 'dim-sessionHistoryButton',
          'aria-label': '会话记录',
          'aria-describedby': sessionHistoryTooltipId,
          onClick: onOpenSessionHistory,
        }, h('svg', {
          width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          focusable: 'false', 'aria-hidden': 'true',
        },
        h('path', { d: 'M21 15a3 3 0 0 1-3 3H7l-4 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z' }),
        h('path', { d: 'M8 8h8M8 12h5' }))),
        h('span', {
          id: sessionHistoryTooltipId,
          className: 'dim-sessionHistoryTooltip',
          role: 'tooltip',
        }, '会话记录')) : null,
      h('span', { className: 'dim-generalSettingsAction' },
        h('button', {
          type: 'button',
          id: 'dim-general-settings-trigger',
          className: 'dim-generalSettingsButton',
          'aria-label': '通用设置',
          'aria-describedby': generalSettingsTooltipId,
          'aria-controls': `dim-panel-${GLOBAL_SETTINGS_TAB_ID}`,
          'aria-current': globalSettingsSelected ? 'page' : undefined,
          onClick: () => {
            setSelected(GLOBAL_SETTINGS_TAB_ID);
            setDeliverySettings(null);
          },
        }, h(GlobalSettingsLogoGlyph, { size: 17 })),
        h('span', {
          id: generalSettingsTooltipId,
          className: 'dim-generalSettingsTooltip',
          role: 'tooltip',
        }, '通用设置'))),
    ),
    h('div', { className: 'dim-layout' },
      h('nav', { className: 'dim-rail', role: 'tablist', 'aria-label': 'IM 设置导航' },
        visibleChannels.map((channel) => h('button', {
          key: channel.id,
          type: 'button',
          role: 'tab',
          id: `dim-tab-${channel.id}`,
          className: 'dim-channel',
          'aria-selected': !globalSettingsSelected && channel.id === active.id,
          'aria-controls': `dim-panel-${channel.id}`,
          onClick: () => {
            setSelected(channel.id);
            setDeliverySettings(null);
          },
        },
        h(ChannelLogo, { channel: channel.id }),
        h('span', { className: 'dim-channelCopy' },
          h('strong', null, channel.label),
          channel.note ? h('small', { className: 'dim-channelNote' }, channel.note) : null,
        )))),
      h('div', { className: 'dim-divider', 'aria-hidden': 'true' }),
      h('main', {
        className: 'dim-panel',
        role: 'tabpanel',
        id: activePanelId,
        'aria-labelledby': activeTabId,
      },
      loopbackRecovery
        ? h(LoopbackRecoveryNotice, {
            recovery: loopbackRecovery,
            onNavigate: navigateToRecoveryUrl,
          })
        : null,
      h(BotSettingsContext.Provider, { value: botSettingsContext },
        globalSettingsSelected
          ? h(GlobalSettingsPanel, {
              rpcCall: rpcCalls.globalSettingsRpcCall,
              deliverySyncRpcCall: rpcCalls.deliverySyncRpcCall,
              languageRpcCall: rpcCalls.languageRpcCall,
            })
          : deliverySettings?.channel === active.id
          ? h(DeliveryTargetSettingsPage, {
              channel: active.id,
              account: deliverySettings,
              rpcCall: rpcCalls.deliveryRpcCall,
              accessRpcCall: rpcCalls[`${active.id}RpcCall`],
              onBack: () => setDeliverySettings(null),
            })
          : active.id === 'weixin'
            ? h(WeixinSettingsTab, {
              rpcCall: rpcCalls.weixinRpcCall,
              personaRpcCall: rpcCalls.personaRpcCall,
            })
            : h(QqSettingsTab, {
              rpcCall: rpcCalls.qqRpcCall,
              personaRpcCall: rpcCalls.personaRpcCall,
            }))),
    ),
  ));
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.register(IM_LOCALE_NAMESPACE, { zh, en }),
    'im-settings: bilingual dictionaries',
  );
  // Russian is a language pack rather than a built-in locale: it needs its own
  // definition so it shows up in the Language row, and its lookups chain to
  // English before falling back to the Chinese key itself.
  ctx.effect(
    () => installImRussianLocale(ctx.locale),
    'im-settings: Russian language pack',
  );
  const t = ctx.locale.bind(IM_LOCALE_NAMESPACE);
  setImTranslator(t);

  // The settings page is the only place that knows the locale the interface is
  // actually rendered in: DSH stores nothing when it came from the browser's
  // language list. Report it so bot messages follow the same language.
  ctx.effect(
    () => installInterfaceLanguageMirror(ctx, {
      rpcCall: (endpoint, payload, signal) =>
        callManagementRpc(ctx.connection, HOST_LANGUAGE_RPC_CHANNEL, endpoint, payload, signal),
    }),
    'im-settings: mirror the DSH interface language',
  );

  ctx.effect(() => installSessionChannelLogos(), 'im-settings: Session channel logos');
  let dsBotAvatars;
  ctx.effect(() => {
    dsBotAvatars = installDsBotSessionAvatars(ctx, {
      rpcCall: (endpoint, payload, signal) =>
        callManagementRpc(ctx.connection, DELIVERY_RPC_CHANNEL, endpoint, payload, signal),
    });
    return () => { dsBotAvatars.dispose(); dsBotAvatars = null; };
  }, 'im-settings: bound DS Bot session avatars');

  ctx.effect(() => {
    const disposers = [
      // Base classes shared by the account cards and the remaining tabs.
      installBotSettingsStyles(),
      installWeixinStyles(),
      installQqStyles(),
      installImStyles(),
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'im-settings: install combined channel styles');

  let sidebarSync;
  const managementRpc = async (connection, channel, endpoint, payload, signal) => {
    const result = await callManagementRpc(connection, channel, endpoint, payload, signal);
    if (result?.ok === true) {
      const dsBotRead = channel === DELIVERY_RPC_CHANNEL && endpoint === 'ds-bot.status';
      if (channel === DELIVERY_RPC_CHANNEL && ['ds-bot.bind', 'ds-bot.unbind'].includes(endpoint)) dsBotAvatars?.refresh();
      if (endpoint === SIDEBAR_SETTINGS_ENDPOINTS.set) sidebarSync?.apply(result);
      else if (!dsBotRead && endpoint !== SIDEBAR_SETTINGS_ENDPOINTS.get) sidebarSync?.refresh();
    }
    return result;
  };
  const weixinRpcCall = (endpoint, payload, signal) =>
    managementRpc(ctx.connection, WEIXIN_RPC_CHANNEL, endpoint, payload, signal);
  const qqRpcCall = (endpoint, payload, signal) =>
    managementRpc(ctx.connection, QQ_RPC_CHANNEL, endpoint, payload, signal);
  const personaRpcCall = (endpoint, payload, signal) =>
    managementRpc(ctx.connection, PERSONA_RPC_CHANNEL, endpoint, payload, signal);
  const deliveryRpcCall = (endpoint, payload, signal) =>
    managementRpc(ctx.connection, DELIVERY_RPC_CHANNEL, endpoint, payload, signal);
  const globalSettingsRpcCall = (endpoint, payload, signal) =>
    managementRpc(ctx.connection, Object.values(SIDEBAR_SETTINGS_ENDPOINTS).includes(endpoint)
      ? SIDEBAR_SETTINGS_RPC_CHANNEL : GLOBAL_SETTINGS_RPC_CHANNEL, endpoint, payload, signal);
  const deliverySyncRpcCall = (endpoint, payload, signal) =>
    managementRpc(ctx.connection, DELIVERY_SYNC_SETTINGS_RPC_CHANNEL, endpoint, payload, signal);
  const languageRpcCall = (endpoint, payload, signal) =>
    managementRpc(ctx.connection, HOST_LANGUAGE_RPC_CHANNEL, endpoint, payload, signal);
  const channelListRpcCall = (endpoint, payload, signal) =>
    managementRpc(ctx.connection, CHANNEL_LIST_RPC_CHANNEL, endpoint, payload, signal);
  const workspaceDirectoryPicker = Object.freeze({
    listDirectory: (path, signal) =>
      callWorkspaceDirectoryApi(ctx, 'listDirectory', path, signal),
    pickDirectory: () => callWorkspaceDirectoryApi(ctx, 'pickDirectory'),
  });

  const panelDependencies = {
    qqRpcCall,
    weixinRpcCall,
    personaRpcCall,
    deliveryRpcCall,
    globalSettingsRpcCall,
    languageRpcCall,
    deliverySyncRpcCall,
    channelListRpcCall,
    workspaceDirectoryPicker,
  };
  const subscribeLocale = (listener) => typeof ctx.on === 'function'
    ? ctx.on('locale/change', listener) : () => {};
  const localeSnapshot = () => ctx.locale.getLocale?.()?.active ?? '';

  // Stable for this plugin lifetime: creating an element must not create a
  // new component type and reset the reader's selected tab or unsaved input.
  function IMPanel({ preferredSectionId }) {
    React.useSyncExternalStore(subscribeLocale, localeSnapshot, localeSnapshot);
    const historyAvailable = React.useSyncExternalStore(
      channelSessionsPage.subscribe, channelSessionsPage.available, channelSessionsPage.available,
    );
    return h(IMPanelErrorBoundary, null,
      h(IMSettingsTab, {
        ...panelDependencies, preferredSectionId,
        onOpenSessionHistory: historyAvailable ? channelSessionsPage.open : undefined,
      }));
  }
  const buildPanelElement = (props = {}) => h(IMPanel, {
    preferredSectionId: props.preferredSectionId,
  });

  const pluginPage = installImPluginPage(ctx, {
    packageName: manifest.name,
    renderPanel: buildPanelElement,
  });
  const channelSessionsPage = installChannelSessionsPage(ctx, { channelListRpcCall });

  ctx.effect(() => {
    sidebarSync = installSidebarVisibilitySync({
      rpcCall: (endpoint, payload, signal) =>
        callManagementRpc(ctx.connection, SIDEBAR_SETTINGS_RPC_CHANNEL, endpoint, payload, signal),
      setVisible: (visible) => pluginPage.setSidebarVisible(visible),
    });
    return () => { sidebarSync.dispose(); sidebarSync = null; };
  }, 'im-settings: sidebar visibility');

  ctx.effect(() => {
    let disposed = false;
    let stopSettings = null;
    let registered = false;
    const setSettingsVisible = (visible) => {
      if (disposed) return;
      if (typeof visible !== 'boolean') throw new TypeError('visible must be a boolean');
      if (visible === (stopSettings !== null)) return;
      if (!visible) {
        const stop = stopSettings;
        stopSettings = null;
        stop();
        return;
      }
      // The existing slot controller owns late declarations, withdrawal and
      // re-declaration. Cancelling it also cancels a pending registration.
      stopSettings = ctx.slots.inject('settings.section', () => {
        const unregister = ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-im-persona',
          order: 21,
          label: () => t('IM机器人'),
          locale: IM_LOCALE_NAMESPACE,
          inject: () => panelDependencies,
        }, buildPanelElement);
        registered = true;
        return () => {
          registered = false;
          unregister();
        };
      });
    };

    // Publish only after the default registration is established, so a
    // consumer hiding it during service discovery cannot be overridden.
    setSettingsVisible(true);
    if (typeof ctx.provide === 'function') {
      ctx.provide('dshImClient', Object.freeze({
        version: 1,
        render: (props) => disposed ? null : buildPanelElement(props),
        setSettingsVisible,
        settingsVisible: () => !disposed && registered,
      }));
    }
    return () => {
      disposed = true;
      const stop = stopSettings;
      stopSettings = null;
      registered = false;
      stop?.();
    };
  }, 'im-settings: client panel service');
}
