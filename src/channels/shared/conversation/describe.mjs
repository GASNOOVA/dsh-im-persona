/**
 * Decode a stored conversation key back into the parts a caller can reason
 * about: whether it is a direct chat or a group, plus the ids inside it.
 *
 * The keys are written by the remaining channel bridges, so this reader only
 * accepts the shapes they own. It never invents a key: an unknown or malformed
 * string yields `null` and the caller treats the conversation as unidentified.
 *
 * Known shapes (personal edition: Weixin + QQ only):
 *   p2p:<userId>     Weixin private chat (the suffix is the peer user id)
 *   c2c:<openId>     QQ private chat
 *   group:<id>       QQ group chat
 *
 * The Matrix `direct:dm:`, Feishu `p2p:` legacy, DingTalk, WeCom, Telegram
 * topic, Slack thread and similar shapes were removed with those channels.
 */

/**
 * @typedef {Object} ParsedConversationKey
 * @property {'dm'|'group'} chatType
 * @property {?string} chatId
 * @property {?string} threadId
 * @property {?string} senderId
 */

const SEP = ':';

/** Everything before the first separator is the scope. */
function scopeOf(key) {
  const index = key.indexOf(SEP);
  return index === -1 ? key : key.slice(0, index);
}

function restOf(key) {
  const index = key.indexOf(SEP);
  return index === -1 ? '' : key.slice(index + 1);
}

function dm(senderId) {
  return { chatType: 'dm', chatId: null, threadId: null, senderId: senderId || null };
}

/**
 * Decode one conversation key.
 * @param {unknown} key stored conversation key
 * @param {{channel?: string}} [options] channel that stored the key; retained
 *   for callers that pass it, but the remaining shapes are unambiguous
 * @returns {?ParsedConversationKey} parts, or null when the key is not ours
 */
export function parseConversationKey(key, { channel } = {}) {
  void channel;
  if (typeof key !== 'string' || key === '' || key.length > 1_024) return null;
  const scope = scopeOf(key);
  const rest = restOf(key);
  if (rest === '') return null;
  // `p2p:` (Weixin) and `c2c:` (QQ) keys are written per sender, so the suffix
  // is the peer user id. Neither channel persists a thread id today.
  if (scope === 'p2p' || scope === 'c2c') return dm(rest);
  if (scope === 'group') return { chatType: 'group', chatId: rest, threadId: null, senderId: null };
  return null;
}
