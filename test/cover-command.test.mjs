import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coverAckText,
  findBilibiliUrl,
  isCoverCommandText,
  parseCoverCommand,
} from '../src/channels/wechat-personal/cover-command.mjs';

test('findBilibiliUrl finds BV links, av links and b23 short links', () => {
  assert.equal(findBilibiliUrl('看看这个 https://www.bilibili.com/video/BV1xx411c7mD?p=1 吧'), 'https://www.bilibili.com/video/BV1xx411c7mD?p=1');
  assert.equal(findBilibiliUrl('https://bilibili.com/video/av12345'), 'https://bilibili.com/video/av12345');
  assert.equal(findBilibiliUrl('https://b23.tv/abcdEF'), 'https://b23.tv/abcdEF');
  assert.equal(findBilibiliUrl('https://example.com/video/BV1xx411c7mD'), '');
  assert.equal(findBilibiliUrl(''), '');
});

test('parseCoverCommand requires the cover keyword and a Bilibili link', () => {
  assert.ok(parseCoverCommand('翻唱 https://www.bilibili.com/video/BV1xx411c7mD', {}));
  assert.equal(parseCoverCommand('https://www.bilibili.com/video/BV1xx411c7mD', {}), null);
  assert.equal(parseCoverCommand('翻唱 没有链接', {}), null);
  assert.equal(parseCoverCommand('', {}), null);
});

test('parseCoverCommand extracts url, prompt and mix flag', () => {
  const command = parseCoverCommand(
    '麻烦翻唱一下 https://www.bilibili.com/video/BV1xx411c7mD ，温柔一点的语气，混音版。',
    { maxPromptChars: 300 },
  );
  assert.ok(command);
  assert.equal(command.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(command.mix, true);
  assert.match(command.prompt, /温柔一点/u);
  assert.doesNotMatch(command.prompt, /https?:/u);
  assert.doesNotMatch(command.prompt, /翻唱/u);

  const pure = parseCoverCommand('翻唱 https://b23.tv/abcdEF 随便唱唱', { maxPromptChars: 300 });
  assert.ok(pure);
  assert.equal(pure.mix, false);
  assert.equal(pure.prompt, '随便唱唱');
});

test('parseCoverCommand truncates prompts and rejects empty urls', () => {
  const long = '翻唱 https://www.bilibili.com/video/BV1xx411c7mD ' + 'a'.repeat(500);
  const command = parseCoverCommand(long, { maxPromptChars: 40 });
  assert.ok(command);
  assert.equal(command.prompt.length, 40);

  assert.equal(parseCoverCommand('翻唱 没有链接', {}), null);
});

test('isCoverCommandText and coverAckText describe the pending job', () => {
  const text = '翻唱 https://www.bilibili.com/video/BV1xx411c7mD';
  assert.equal(isCoverCommandText(text), true);
  assert.equal(isCoverCommandText('你好'), false);
  assert.match(coverAckText({ mix: false }), /纯人声/u);
  assert.match(coverAckText({ mix: true }), /混音/u);
});
