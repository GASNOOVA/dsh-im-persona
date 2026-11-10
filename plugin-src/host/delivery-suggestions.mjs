// Conversation-key to delivery-route mapping for the remaining channels.
// Only Weixin and QQ are kept in the personal edition, so every other channel's
// key grammar (Feishu p2p/group, Telegram chat/topic, Slack thread, Discord
// channel, WhatsApp JID, iMessage GUID, email address, Matrix room, DingTalk,
// WeCom) has been removed with the channel itself.
const CHANNELS = new Set([
  'weixin',
  'qq',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function opaqueId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\s:\u0000-\u001f\u007f]/u.test(value);
}

function afterPrefix(key, prefix) {
  const marker = `${prefix}:`;
  if (!key.startsWith(marker)) return null;
  const value = key.slice(marker.length);
  return opaqueId(value) ? value : null;
}

function simpleSuggestion(key, definitions) {
  for (const [prefix, kind, field] of definitions) {
    const value = afterPrefix(key, prefix);
    if (value) return { kind, route: { [field]: value } };
  }
  return null;
}

/** Convert one persisted conversation key into a stable proactive-delivery route. */
export function deliverySuggestionFromConversationKey(channel, key) {
  if (!CHANNELS.has(channel) || typeof key !== 'string') return null;
  switch (channel) {
    case 'weixin':
      return simpleSuggestion(key, [['p2p', 'user', 'toUserId']]);
    case 'qq':
      return simpleSuggestion(key, [
        ['c2c', 'user', 'userOpenId'],
        ['group', 'group', 'groupOpenId'],
      ]);
    default:
      return null;
  }
}

/** Convert only a persisted private-chat key into its stable delivery route. */
export function privateDeliverySuggestionFromConversationKey(channel, key) {
  const separator = typeof key === 'string' ? key.indexOf(':') : -1;
  const prefix = separator > 0 ? key.slice(0, separator) : '';
  const privatePrefix = {
    weixin: 'p2p',
    qq: 'c2c',
  }[channel];
  if (!privatePrefix || prefix !== privatePrefix) return null;
  return deliverySuggestionFromConversationKey(channel, key);
}

function routeIdentity(value) {
  if (!isRecord(value?.route) || typeof value.kind !== 'string') return null;
  return JSON.stringify([
    value.kind,
    Object.keys(value.route).sort().map((key) => [key, value.route[key]]),
  ]);
}

/** Check that one saved private conversation key still identifies this target route. */
export function privateConversationKeyMatchesTarget(channel, key, target) {
  const suggestion = privateDeliverySuggestionFromConversationKey(channel, key);
  const suggestionIdentity = routeIdentity(suggestion);
  return suggestionIdentity !== null && suggestionIdentity === routeIdentity(target);
}

/** Resolve exactly one current private conversation for a normalized delivery target. */
export function resolvePrivateConversationKey(channel, sessions, target) {
  if (!CHANNELS.has(channel) || !isRecord(sessions)) return null;
  const matches = [];
  for (const [key, sessionId] of Object.entries(sessions)) {
    if (typeof sessionId !== 'string' || !sessionId) continue;
    if (privateConversationKeyMatchesTarget(channel, key, target)) matches.push(key);
    if (matches.length > 1) return null;
  }
  return matches[0] ?? null;
}

/**
 * Check that one saved conversation key still identifies this target route.
 *
 * Unlike the private variant this accepts every route the channel can persist —
 * a QQ group chat, for example — because mirrored text is not limited to
 * private chat. Questions and approvals keep the private gate: they are
 * resolved through `privateConversationKeyMatchesTarget` instead.
 */
export function conversationKeyMatchesTarget(channel, key, target) {
  const suggestionIdentity = routeIdentity(deliverySuggestionFromConversationKey(channel, key));
  return suggestionIdentity !== null && suggestionIdentity === routeIdentity(target);
}

/** Resolve exactly one current conversation of any route kind for a normalized delivery target. */
export function resolveConversationKey(channel, sessions, target) {
  if (!CHANNELS.has(channel) || !isRecord(sessions)) return null;
  const matches = [];
  for (const [key, sessionId] of Object.entries(sessions)) {
    if (typeof sessionId !== 'string' || !sessionId) continue;
    if (conversationKeyMatchesTarget(channel, key, target)) matches.push(key);
    if (matches.length > 1) return null;
  }
  return matches[0] ?? null;
}

/**
 * Extract and de-duplicate stable delivery routes from a persisted sessions map.
 * Session ids and every other state field are intentionally ignored.
 */
export function deliverySuggestionsFromSessions(channel, sessions) {
  if (!CHANNELS.has(channel) || !isRecord(sessions)) return [];
  const suggestions = [];
  const seen = new Set();
  for (const key of Object.keys(sessions)) {
    const suggestion = deliverySuggestionFromConversationKey(channel, key);
    if (!suggestion) continue;
    const identity = JSON.stringify(suggestion);
    if (seen.has(identity)) continue;
    seen.add(identity);
    suggestions.push(suggestion);
  }
  return suggestions;
}
