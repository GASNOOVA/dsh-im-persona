import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_GROUP_BRAIN_SETTINGS,
  GROUP_BRAIN_LIMITS,
  groupBrainRoot,
  isGroupAllowed,
  normalizeAllowedGroup,
  normalizeGroupBrainSettings,
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
