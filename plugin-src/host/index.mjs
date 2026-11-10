import { installGroupHistoryTools } from '../../src/channels/shared/group-history-access.mjs';
import { apply as applyQq } from './channels/qq/index.mjs';
import { apply as applyWeixin } from './channels/weixin/index.mjs';
import { installOutboundArtifactTool } from '../../src/channels/shared/semantic/artifact.mjs';
import { installHostLanguage } from './host-language.mjs';
import { installHostLanguageRpc } from './host-language-rpc.mjs';
import { installDeliveryRpc } from './delivery-rpc.mjs';
import { installDeliveryHttp } from './delivery-http.mjs';
import { createDeliveryService } from './delivery-service.mjs';
import { createDsBotClient } from './ds-bot-client.mjs';
import { installDsBotQuestionSync } from './ds-bot-question-sync.mjs';
import { installInboundTtlRpc } from './inbound-ttl-rpc.mjs';
import { installDeliverySyncRpc } from './delivery-sync-rpc.mjs';
import { installSidebarSettingsRpc } from './sidebar-settings.mjs';
import { installInjectedContext } from './injected-context.mjs';
import { installSessionSyncCoordinator } from './session-sync-coordinator.mjs';
import { deliverySwitchesOff } from '../../src/channels/shared/delivery-sync-settings.mjs';
import { getDeliverySyncSettingsStore } from '../../src/channels/shared/delivery-sync-settings-store.mjs';
import { installSessionTitlePrefix } from './session-title-prefix.mjs';
import { installChannelListRpc } from './channel-list-rpc.mjs';
import { installPersonaRpc } from './persona-rpc.mjs';
import { installWechatPersonalRuntime } from './wechat-personal-runtime.mjs';

export const name = 'dsh-im-persona-host';
export const inject = [
  'connection',
  'credentials',
  'typertGateway',
];

function channelConfig(config, name, deliveryService) {
  const channel = {
    ...(config.dshHome ? { dshHome: config.dshHome } : {}),
    ...(config.groupByAgentPreset === undefined ? {} : { groupByAgentPreset: config.groupByAgentPreset }),
    ...config[name],
  };
  // 顶层 config.personaFile 作为共享的人设库 config 条目；渠道级配置可覆盖。
  if (config.personaFile !== undefined && channel.personaFile === undefined) {
    channel.personaFile = config.personaFile;
  }
  const withAuthority = config.rpcAuthority === undefined
    ? channel
    : { ...channel, rpcAuthority: config.rpcAuthority };
  return { ...withAuthority, deliveryService };
}

export function createImHostPlugin(internals = {}) {
  const startHostLanguage = internals.installHostLanguage ?? installHostLanguage;
  const startHostLanguageRpc = internals.installHostLanguageRpc ?? installHostLanguageRpc;
  const startInboundTtl = internals.installInboundTtlRpc ?? installInboundTtlRpc;
  const startDeliverySync = internals.installDeliverySyncRpc ?? installDeliverySyncRpc;
  const startSidebarSettings = internals.installSidebarSettingsRpc ?? installSidebarSettingsRpc;
  const startInjectedContext = internals.installInjectedContext ?? installInjectedContext;
  const startPersonaRpc = internals.installPersonaRpc ?? installPersonaRpc;
  const startWechatPersonal = internals.installWechatPersonalRuntime ?? installWechatPersonalRuntime;
  const startDelivery = internals.installDeliveryRpc ?? installDeliveryRpc;
  const startDeliveryHttp = internals.installDeliveryHttp ?? installDeliveryHttp;
  const startSessionSync = internals.installSessionSyncCoordinator
    ?? installSessionSyncCoordinator;
  const makeDeliveryService = internals.createDeliveryService ?? createDeliveryService;
  const startWeixin = internals.applyWeixin ?? applyWeixin;
  const startQq = internals.applyQq ?? applyQq;
  // Personal edition: only Weixin and QQ are supported channels.
  const channels = [
    ['weixin', startWeixin],
    ['qq', startQq],
  ];
  return Object.freeze({
    name,
    inject,
    async apply(ctx, config = {}) {
      const unavailableSessionSyncChannels = channels
        .map(([channel]) => channel)
        .filter((channel) => config[channel]?.harnessBaseUrl !== undefined);
      const deliveryService = makeDeliveryService({
        unavailableSessionSyncChannels,
        dsBot: createDsBotClient(ctx),
      });
      // The delivery switches are the master for everything that follows a Session
      // through its targets: with both off, `listSessionSyncTargets` answers empty,
      // so the coordinator sends nothing. A settings read failure must not disable
      // delivery, so it falls through.
      if (typeof deliveryService.listSessionSyncTargets === 'function') {
        const rawListSessionSyncTargets = deliveryService.listSessionSyncTargets.bind(deliveryService);
        deliveryService.listSessionSyncTargets = async (sessionId) => {
          try {
            if (deliverySwitchesOff(await getDeliverySyncSettingsStore(config).get())) return [];
          } catch {
            // keep the unwrapped behaviour
          }
          return rawListSessionSyncTargets(sessionId);
        };
      }
      /** Sessions already reported, so the log stays one line per session. */
      const describedSessions = new Set();
      const describeConversationLogged = async (sessionId) => {
        const described = await deliveryService.describeConversation(sessionId);
        if (described && !describedSessions.has(sessionId)) {
          describedSessions.add(sessionId);
          const log = typeof ctx?.logger === 'function' ? ctx.logger(name) : (ctx?.logger ?? console);
          try {
            log?.info?.(`describeConversation session=${sessionId} chat=${described.conversationKey} sender=${described.senderId ?? '-'}`);
          } catch {
            // Logging must never break the lookup.
          }
        }
        return described;
      };
      if (typeof ctx?.provide === 'function') {
        ctx.provide('dshIm', Object.freeze({
          contractVersion: 1,
          receiptVersion: 1,
          inboundVersion: 1,
          consumeInbound: (botId, options) => deliveryService.consumeInbound(botId, options),
          historyChecked: (botId, route, query, options) => deliveryService.historyChecked(botId, route, query, options),
          replyChecked: (botId, route, text, options) => deliveryService.replyChecked(botId, route, text, options),
          describeConversation: (sessionId) => describeConversationLogged(sessionId),

          // Prompt assembly is synchronous, so a caller that needs the identity
          // before the first step cannot await the async variant.
          describeConversationSync: (sessionId) => deliveryService.describeConversationSync(sessionId),
          describeBot: (botId) => deliveryService.describeBot(botId),
          sendChecked: (botId, targetId, text, options) => deliveryService.sendChecked(botId, targetId, text, options),
          send: (botId, targetId, text, options) => (
            deliveryService.send(botId, targetId, text, options)
          ),
          listTargets: async (botId) => (await deliveryService.listTargets(botId)).targets,
          createTarget: (botId, target) => deliveryService.createTarget(botId, target),
          listBots: () => deliveryService.listBots(),
        }));
      }
      const activate = async (readyCtx) => {
        await activateChannels(readyCtx, config, deliveryService);
      };
      if (typeof ctx?.inject === 'function') {
        await ctx.inject(
          ['sessionController', 'workspaceController'],
          activate,
        );
        ctx.inject(['webServer'], (httpCtx) => {
          startDeliveryHttp(httpCtx, deliveryService);
        });
        return;
      }
      await activate(ctx);
      if (ctx?.webServer?.register && typeof ctx?.effect === 'function') {
        startDeliveryHttp(ctx, deliveryService);
      }
    },
  });

  async function activateChannels(ctx, config, deliveryService) {
    // Bind the bot message language before any channel connects, so the first
    // command menu a platform stores is already in the interface language.
    const hostLanguage = startHostLanguage(ctx, config);
    await hostLanguage?.ready;
    const startTitlePrefix = (titleCtx) => {
      // The installer owns its cleanup through ctx.effect(). Cordis startup
      // callbacks must not return its controller object as an effect.
      installSessionTitlePrefix(titleCtx, {
        logger: typeof titleCtx?.logger === 'function'
          ? titleCtx.logger('dsh-im:session-title') : (titleCtx?.logger ?? console),
      });
    };
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['sessions'], startTitlePrefix);
    } else if (ctx?.sessions && typeof ctx.on === 'function') {
      startTitlePrefix(ctx);
    }
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['tools', 'systemPrompt'], (artifactCtx) => {
        installOutboundArtifactTool(artifactCtx);
        installGroupHistoryTools(artifactCtx);
      });
    } else {
      installOutboundArtifactTool(ctx);
      installGroupHistoryTools(ctx);
    }
    const logger = typeof ctx?.logger === 'function'
      ? ctx.logger(name)
      : (ctx?.logger ?? console);
    try {
      startInjectedContext(ctx, { logger });
    } catch (error) {
      logger.error?.('[dsh-im] failed to activate injected-context pairing; prompts keep the inline prefix', error);
    }
    if (ctx?.connection?.fetch) {
      if (hostLanguage) {
        try {
          startHostLanguageRpc(ctx, hostLanguage, config.rpcAuthority);
        } catch (error) {
          logger.error?.('[dsh-im] failed to activate interface language mirroring; continuing with channels', error);
        }
      }
      try {
        startSidebarSettings(ctx, { config });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate sidebar settings; continuing with channels', error);
      }
      try {
        startInboundTtl(ctx, { config });
        startDeliverySync(ctx, { config });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate inbound TTL settings; continuing with channels', error);
      }
      try {
        startDelivery(ctx, deliveryService, { authority: config.rpcAuthority });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate delivery management; continuing with channels', error);
      }
      try {
        installChannelListRpc(ctx, config.rpcAuthority, { dshHome: config.dshHome });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate channel list; continuing with channels', error);
      }
      try {
        startPersonaRpc(ctx, { authority: config.rpcAuthority, config });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate persona settings; continuing with channels', error);
      }
    }
    const failures = [];
    // Each channel mounts its management RPC before awaiting initialization.
    // Start them together so a slow channel cannot leave later routes absent.
    await Promise.all(channels.map(async ([channel, start]) => {
      try {
        await start(ctx, channelConfig(config, channel, deliveryService));
      } catch (error) {
        failures.push(error);
        logger.error?.(`[dsh-im] failed to activate ${channel}; continuing with the remaining channels`, error);
      }
    }));
    if (failures.length === channels.length) {
      throw new AggregateError(failures, 'dsh-im failed to activate every channel');
    }
    // 微信个人号是群聊大脑的输入源，不占用独立渠道；未启用时这里只是读取设置并返回。
    try {
      await startWechatPersonal(ctx, { config });
    } catch (error) {
      logger.error?.('[dsh-im] failed to activate WeChat personal runtime; continuing', error);
    }
    if (typeof ctx?.on === 'function') {
      try {
        startSessionSync(ctx, deliveryService, {
          logger,
          inputScope: ctx.root ?? ctx,
          config,
        });
        installDsBotQuestionSync(ctx, deliveryService, { logger });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate Session sync; continuing with channels', error);
      }
    }
  }
}

export async function apply(ctx, config = {}) {
  return createImHostPlugin().apply(ctx, config);
}
