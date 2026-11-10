import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_GROUP_BRAIN_SETTINGS,
  DEFAULT_WECHAT_PERSONAL_SETTINGS,
  GROUP_BRAIN_LIMITS,
  groupBrainRoot,
  isGroupAllowed,
  normalizeAllowedGroup,
  normalizeGroupBrainSettings,
  normalizeWechatPersonalSettings,
} from '../src/channels/shared/group-brain/group-brain-config.mjs';

test('group brain settings normalize unknown input to conservative defaults', () => {
  const settings = normalizeGroupBrainSettings({
    enabled: 'yes',
    maxMembers: 999,
    allowedGroups: [
      { channel: 'qq', botId: 'bot-1', chatId: 'group-1', groupName: '小群' },
      { channel: 'qq', botId: 'bot-1', chatId: 'group-1' },
      { channel: '', botId: 'bot-2', chatId: 'group-2' },
      null,
    ],
    ambient: { enabled: true, silenceMs: 5, minMessages: 0, cooldownMs: -1, maxPerHour: 999, maxPerDay: 2 },
    memory: { consolidateIntervalDays: 30, segmentGapMs: 1, maxMemoryChars: 64_000 },
    profiles: { enabled: false, maxProfiles: 99 },
    wechatPersonal: {
      enabled: 'yes',
      daemonUrl: 'ftp://nope',
      tokenPath: 42,
      accountId: 'bad id!',
      personaId: '',
    },
  });
  assert.equal(settings.enabled, DEFAULT_GROUP_BRAIN_SETTINGS.enabled);
  assert.equal(settings.maxMembers, DEFAULT_GROUP_BRAIN_SETTINGS.maxMembers);
  assert.equal(settings.allowedGroups.length, 1);
  assert.equal(settings.allowedGroups[0].groupName, '小群');
  assert.equal(settings.ambient.enabled, true);
  assert.equal(settings.ambient.silenceMs, DEFAULT_GROUP_BRAIN_SETTINGS.ambient.silenceMs);
  assert.equal(settings.ambient.minMessages, DEFAULT_GROUP_BRAIN_SETTINGS.ambient.minMessages);
  assert.equal(settings.ambient.maxPerHour, DEFAULT_GROUP_BRAIN_SETTINGS.ambient.maxPerHour);
  assert.equal(settings.ambient.maxPerDay, 2);
  assert.equal(settings.memory.segmentGapMs, DEFAULT_GROUP_BRAIN_SETTINGS.memory.segmentGapMs);
  assert.equal(settings.profiles.enabled, false);
  assert.equal(settings.profiles.maxProfiles, DEFAULT_GROUP_BRAIN_SETTINGS.profiles.maxProfiles);
  assert.equal(settings.wechatPersonal.enabled, DEFAULT_WECHAT_PERSONAL_SETTINGS.enabled);
  assert.equal(settings.wechatPersonal.daemonUrl, DEFAULT_WECHAT_PERSONAL_SETTINGS.daemonUrl);
  assert.equal(settings.wechatPersonal.tokenPath, '');
  assert.equal(settings.wechatPersonal.accountId, '');
  assert.equal(settings.wechatPersonal.personaId, DEFAULT_WECHAT_PERSONAL_SETTINGS.personaId);
});

test('group brain settings reject non-record input and normalize group entries', () => {
  assert.equal(normalizeGroupBrainSettings(null), null);
  assert.equal(normalizeGroupBrainSettings('nope'), null);
  assert.equal(normalizeAllowedGroup('nope'), null);
  assert.deepEqual(
    normalizeAllowedGroup({ channel: ' qq ', botId: ' bot ', chatId: ' group ', groupName: ' 群 名 ' }),
    { channel: 'qq', botId: 'bot', chatId: 'group', groupName: '群 名' },
  );
});

test('group allowlist matches channel, bot and chat exactly', () => {
  const settings = normalizeGroupBrainSettings({
    allowedGroups: [{ channel: 'qq', botId: 'bot-1', chatId: 'group-1' }],
  });
  assert.equal(isGroupAllowed(settings, { channel: 'qq', botId: 'bot-1', chatId: 'group-1' }), true);
  assert.equal(isGroupAllowed(settings, { channel: 'qq', botId: 'bot-2', chatId: 'group-1' }), false);
  assert.equal(isGroupAllowed(settings, { channel: 'qq', botId: 'bot-1', chatId: 'group-2' }), false);
});

test('group brain root lives next to the other dsh-im state', () => {
  assert.equal(groupBrainRoot('/home/user/.dsh'), '/home/user/.dsh/integrations/dsh-im/group-brain');
  assert.equal(groupBrainRoot(undefined).endsWith('/integrations/dsh-im/group-brain'), true);
});

test('wechat personal settings validate daemon url, account id and persona', () => {
  const defaults = normalizeWechatPersonalSettings(undefined);
  assert.deepEqual(defaults, DEFAULT_WECHAT_PERSONAL_SETTINGS);

  const settings = normalizeWechatPersonalSettings({
    enabled: true,
    daemonUrl: 'http://127.0.0.1:16174/',
    tokenPath: '/mnt/volume/dsh/.im/agent-wechat/aw-data/api-token',
    accountId: 'xiaohao',
    personaId: 'dafeiyu-group',
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.daemonUrl, 'http://127.0.0.1:16174');
  assert.equal(settings.tokenPath, '/mnt/volume/dsh/.im/agent-wechat/aw-data/api-token');
  assert.equal(settings.accountId, 'xiaohao');
  assert.equal(settings.personaId, 'dafeiyu-group');

  const badAccount = normalizeWechatPersonalSettings({ accountId: 'bad id!', daemonUrl: 'not a url' });
  assert.equal(badAccount.accountId, '');
  assert.equal(badAccount.daemonUrl, DEFAULT_WECHAT_PERSONAL_SETTINGS.daemonUrl);
  assert.equal(badAccount.personaId, 'dafeiyu-group');

  const merged = normalizeGroupBrainSettings({ wechatPersonal: settings });
  assert.equal(merged.wechatPersonal.accountId, 'xiaohao');
});
