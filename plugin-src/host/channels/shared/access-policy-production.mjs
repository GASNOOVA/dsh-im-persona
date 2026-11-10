import {
  createAccessPolicy,
  createAccessPolicyScope,
} from '../../../../src/channels/shared/access-policy.mjs';

function policyUsers(users) {
  return users.map((id) => ({ id, canExecuteCommands: true }));
}

function openScope(allowlistUsers = []) {
  return createAccessPolicyScope({
    mode: 'open',
    open: {
      defaultCanExecuteCommands: true,
      commandPermissionOverrides: [],
    },
    allowlist: { users: policyUsers(allowlistUsers) },
  });
}

function allowlistScope(users = []) {
  return createAccessPolicyScope({
    mode: 'allowlist',
    open: {
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [],
    },
    allowlist: { users: policyUsers(users) },
  });
}

function cleanIds(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .filter((value) => typeof value === 'string' || typeof value === 'number'
      || typeof value === 'bigint')
    .map((value) => String(value).trim())
    .filter(Boolean))];
}

/**
 * Build the one-time, backwards-compatible seed for a bot whose workspace
 * document does not yet contain an access policy.
 */
export function initialAccessPolicyFor(channel, config = {}) {
  const key = String(channel ?? '').trim().toLowerCase();
  if (key === 'weixin') {
    return createAccessPolicy({
      direct: allowlistScope(),
      group: allowlistScope(),
    });
  }
  if (key === 'qq') {
    const owners = cleanIds(config.ownerUserOpenid);
    return createAccessPolicy({
      direct: owners.includes('*') ? openScope() : allowlistScope(),
      group: openScope(),
    });
  }
  throw new TypeError(`Unsupported access-policy channel: ${channel}`);
}

/**
 * Seed newly connected bots after startup has migrated existing bots with
 * initialAccessPolicyFor(). Open QQ messages and commands in both chat types;
 * workspace ensure() preserves any policy already saved.
 */
export function newBotAccessPolicyFor(channel, config = {}) {
  const key = String(channel ?? '').trim().toLowerCase();
  if (key === 'qq') {
    return createAccessPolicy({ direct: openScope(), group: openScope() });
  }
  return initialAccessPolicyFor(channel, config);
}

export function privilegedSenderIdsFor(channel, config = {}) {
  const key = String(channel ?? '').trim().toLowerCase();
  if (key === 'weixin') return cleanIds(config.ownerUserId);
  if (key === 'qq') return cleanIds(config.ownerUserOpenid).filter((id) => id !== '*');
  return [];
}

export function accessPolicyProvider(workspaces, botId, { channel, config, equals } = {}) {
  if (!workspaces || typeof workspaces.accessPolicyFor !== 'function') {
    throw new TypeError('A workspace store with access policies is required');
  }
  const privilegedSenderIds = new Set(privilegedSenderIdsFor(channel, config));
  const sameSender = typeof equals === 'function' ? equals : (left, right) => left === right;
  return Object.freeze({
    botId,
    getSettings: () => workspaces.accessPolicyFor(botId),
    isPrivileged(senderIds, conversationType) {
      if (!['direct', 'group'].includes(conversationType)) return false;
      const candidates = Array.isArray(senderIds) ? senderIds : [senderIds];
      try {
        return candidates.some((senderId) => typeof senderId === 'string'
          && [...privilegedSenderIds].some((privilegedId) => (
            sameSender(senderId.trim(), privilegedId) === true
          )));
      } catch {
        return false;
      }
    },
  });
}
