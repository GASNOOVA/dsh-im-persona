import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationKeyMatchesTarget,
  deliverySuggestionFromConversationKey,
  privateConversationKeyMatchesTarget,
  privateDeliverySuggestionFromConversationKey,
  resolveConversationKey,
  resolvePrivateConversationKey,
} from '../plugin-src/host/delivery-suggestions.mjs';

const WEIXIN_TARGET = { kind: 'user', route: { toUserId: 'wx-user-1' } };
const QQ_USER_TARGET = { kind: 'user', route: { userOpenId: 'openid-1' } };
const QQ_GROUP_TARGET = { kind: 'group', route: { groupOpenId: 'group-openid-1' } };

test('a Weixin p2p key maps to its own user target only', () => {
  const key = 'p2p:wx-user-1';
  assert.deepEqual(deliverySuggestionFromConversationKey('weixin', key), WEIXIN_TARGET);
  assert.equal(conversationKeyMatchesTarget('weixin', key, WEIXIN_TARGET), true);
  assert.equal(conversationKeyMatchesTarget('weixin', key, {
    kind: 'user', route: { toUserId: 'wx-user-2' },
  }), false);
  assert.equal(conversationKeyMatchesTarget('weixin', key, { ...WEIXIN_TARGET, targetId: 'daily' }), true,
    'targetId and name are not part of the route identity');
  assert.equal(conversationKeyMatchesTarget('weixin', 'p2p:', WEIXIN_TARGET), false);
});

test('a QQ c2c key maps to its own private target only', () => {
  const key = 'c2c:openid-1';
  assert.deepEqual(deliverySuggestionFromConversationKey('qq', key), QQ_USER_TARGET);
  assert.equal(conversationKeyMatchesTarget('qq', key, QQ_USER_TARGET), true);
  assert.equal(conversationKeyMatchesTarget('qq', key, QQ_GROUP_TARGET), false);
  assert.equal(conversationKeyMatchesTarget('qq', key, {
    kind: 'user', route: { userOpenId: 'openid-2' },
  }), false);
});

test('a QQ group key maps to its own group target only', () => {
  const key = 'group:group-openid-1';
  assert.deepEqual(deliverySuggestionFromConversationKey('qq', key), QQ_GROUP_TARGET);
  assert.equal(conversationKeyMatchesTarget('qq', key, QQ_GROUP_TARGET), true);
  assert.equal(conversationKeyMatchesTarget('qq', key, QQ_USER_TARGET), false);
  assert.equal(conversationKeyMatchesTarget('qq', key, {
    kind: 'group', route: { groupOpenId: 'group-openid-2' },
  }), false);
  assert.equal(conversationKeyMatchesTarget('qq', 'group:', QQ_GROUP_TARGET), false);
});

test('Session sync resolves exactly one matching conversation', () => {
  const sessions = {
    'p2p:wx-user-1': 'session-weixin',
    'c2c:openid-1': 'session-qq',
    'c2c:openid-2': 'session-other',
  };
  assert.equal(resolveConversationKey('weixin', sessions, WEIXIN_TARGET), 'p2p:wx-user-1');
  assert.equal(resolveConversationKey('qq', sessions, QQ_USER_TARGET), 'c2c:openid-1');
  assert.equal(resolveConversationKey('qq', sessions, {
    kind: 'user', route: { userOpenId: 'openid-9' },
  }), null, 'an unknown target cannot be enabled');
  assert.equal(resolveConversationKey('weixin', {}, WEIXIN_TARGET), null);
  assert.equal(resolveConversationKey('unknown', sessions, WEIXIN_TARGET), null);
  assert.equal(resolveConversationKey('qq', null, QQ_USER_TARGET), null);
});

test('malformed and unknown route keys are ignored instead of guessing', () => {
  assert.equal(deliverySuggestionFromConversationKey('qq', 'c2c:'), null);
  assert.equal(deliverySuggestionFromConversationKey('qq', 'c2c:has space'), null);
  assert.equal(deliverySuggestionFromConversationKey('weixin', 'group:group-openid-1'), null,
    'Weixin keys are p2p only');
  assert.equal(resolveConversationKey('qq', {
    'c2c:': 'session-empty',
    'c2c:openid 1': 'session-space',
    'c2c:openid-1': 'session-ok',
  }, QQ_USER_TARGET), 'c2c:openid-1');
});

test('the private helpers stay private-chat only, as the target hints need', () => {
  assert.deepEqual(privateDeliverySuggestionFromConversationKey('weixin', 'p2p:wx-user-1'), WEIXIN_TARGET);
  assert.deepEqual(privateDeliverySuggestionFromConversationKey('qq', 'c2c:openid-1'), QQ_USER_TARGET);
  assert.equal(privateDeliverySuggestionFromConversationKey('qq', 'group:group-openid-1'), null);
  assert.equal(privateConversationKeyMatchesTarget('qq', 'group:group-openid-1', QQ_GROUP_TARGET), false);
  assert.equal(resolvePrivateConversationKey('qq', {
    'group:group-openid-1': 'session-group',
    'c2c:openid-1': 'session-private',
  }, QQ_USER_TARGET), 'c2c:openid-1');
  assert.equal(conversationKeyMatchesTarget('weixin', 'p2p:wx-user-1', QQ_USER_TARGET), false);
});
