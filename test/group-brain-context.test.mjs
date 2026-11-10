// 群聊上下文构建测试：注入块标签/截断、自动接话提示词、归纳提示词与解析器容错。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AMBIENT_MAX_CHARS,
  AMBIENT_REPLY_MAX_CHARS,
  SKIP_TOKEN,
  buildAmbientPrompt,
  buildConsolidationPrompt,
  buildDirectInstructionBlock,
  buildGroupMemoryBlock,
  parseAmbientResult,
  parseConsolidationResult,
} from '../src/channels/shared/group-brain/group-context.mjs';

/** 本地时间 2026-01-01 HH:MM 的时间戳（与渲染端的本地时区一致）。 */
const at = (hour, minute) => new Date(2026, 0, 1, hour, minute).getTime();

test('buildDirectInstructionBlock：固定标签、中文说明、回复对象可缺省', () => {
  const block = buildDirectInstructionBlock({ senderName: '阿明' });
  assert.equal(block.startsWith('<dsh_im_direct_instruction>\n'), true);
  assert.equal(block.endsWith('\n</dsh_im_direct_instruction>'), true);
  assert.ok(block.includes('群聊'));
  assert.ok(block.includes('优先'));
  assert.ok(block.includes('阿明'));

  assert.ok(buildDirectInstructionBlock().includes('群成员'));
  assert.ok(buildDirectInstructionBlock({ senderName: '   ' }).includes('群成员'));
});

test('buildGroupMemoryBlock：标签、两节与成员画像字段渲染', () => {
  const block = buildGroupMemoryBlock({
    memory: '群里最近在约周末爬山。',
    profiles: [{
      displayName: '阿明',
      summary: '组织者',
      traits: ['热心', '爱猫'],
      interests: ['徒步'],
      speakingStyle: '话少',
      relationshipNotes: '老群友',
    }],
  });
  assert.equal(block.startsWith('<dsh_im_group_memory>\n'), true);
  assert.equal(block.endsWith('\n</dsh_im_group_memory>'), true);
  assert.ok(block.includes('## 长期记忆'));
  assert.ok(block.includes('## 成员画像'));
  assert.ok(block.includes('群里最近在约周末爬山。'));
  assert.ok(block.includes('- 阿明：组织者'));
  assert.ok(block.includes('特征：热心、爱猫'));
  assert.ok(block.includes('兴趣：徒步'));
  assert.ok(block.includes('说话风格：话少'));
  assert.ok(block.includes('关系：老群友'));
});

test('buildGroupMemoryBlock：截断优先级为 memory > 当前发送者画像 > 其他画像，且总长受限', () => {
  const block = buildGroupMemoryBlock({
    memory: '核心记忆'.repeat(5),
    profiles: [
      { displayName: '当前发送者', summary: '正在说话的人', isCurrentSender: true },
      { displayName: '普通甲', summary: '甲'.repeat(200) },
      { displayName: '普通乙', summary: '乙的画像' },
    ],
    maxChars: 200,
  });
  assert.ok(block.length <= 200);
  assert.ok(block.includes('核心记忆'));
  assert.ok(block.includes('当前发送者'));
  // 低优先级的画像先被截掉。
  assert.equal(block.includes('普通乙'), false);
});

test('buildGroupMemoryBlock：标记当前发送者的画像排在其他人前面', () => {
  const block = buildGroupMemoryBlock({
    memory: '记忆',
    profiles: [
      { displayName: '路人', summary: '普通成员' },
      { displayName: '本人', summary: '当前说话的人', current: true },
    ],
  });
  assert.ok(block.indexOf('本人') < block.indexOf('路人'));
});

test('buildGroupMemoryBlock：空内容返回空串；超长 memory 截断到 maxChars', () => {
  assert.equal(buildGroupMemoryBlock(), '');
  assert.equal(buildGroupMemoryBlock({ memory: '   ', profiles: [] }), '');

  const block = buildGroupMemoryBlock({ memory: '字'.repeat(5_000), maxChars: 500 });
  assert.ok(block.length <= 500);
  assert.equal(block.startsWith('<dsh_im_group_memory>'), true);
  assert.equal(block.endsWith('</dsh_im_group_memory>'), true);

  // 上限小于标签本身时退化为空串，不输出残缺标签。
  assert.equal(buildGroupMemoryBlock({ memory: 'x', maxChars: 10 }), '');
});

test('buildAmbientPrompt：包含群聊 persona 全文、群规模、记忆、画像与最近对话', () => {
  const persona = '## 人设：大肥鱼（群聊版）\n- 你是群友，不是客服。';
  const prompt = buildAmbientPrompt({
    groupName: '爬山群',
    memberCount: 4,
    segmentMessages: [
      { at: at(9, 5), senderName: '阿明', text: '周末去爬山吗' },
      { at: at(9, 6), senderName: '小夏', text: '好啊好啊' },
    ],
    memory: '大家约过三次爬山。',
    profiles: [{ displayName: '阿明', summary: '组织者' }],
    persona,
  });

  assert.ok(prompt.includes(persona), '应原样包含选中的群聊 persona 全文');
  assert.ok(prompt.includes('爬山群'));
  assert.ok(prompt.includes('仅 4 人小群'));
  assert.ok(prompt.includes('大家约过三次爬山。'));
  assert.ok(prompt.includes('- 阿明：组织者'));
  assert.match(prompt, /\[09:05\] 阿明：周末去爬山吗/);
  assert.match(prompt, /\[09:06\] 小夏：好啊好啊/);
  assert.ok(prompt.includes('80 字'));
  assert.ok(prompt.includes('不 @ 任何人'));
  assert.ok(prompt.includes(SKIP_TOKEN));
});

test('buildAmbientPrompt：复用会话时 compact 省掉人设/记忆/画像，只留最近对话与输出要求', () => {
  const persona = '## 人设：大肥鱼（群聊版）\n- 你是群友，不是客服。';
  const messages = Array.from({ length: 20 }, (_, index) => ({
    at: at(9, 0) + index * 1_000,
    senderName: `友${index}`,
    text: `M${index}`,
  }));
  const prompt = buildAmbientPrompt({
    groupName: '爬山群',
    memberCount: 4,
    segmentMessages: messages,
    memory: '大家约过三次爬山。',
    profiles: [{ displayName: '阿明', summary: '组织者' }],
    persona,
    compact: true,
  });

  assert.equal(prompt.includes(persona), false, '复用会话时不应再注入人设全文');
  assert.equal(prompt.includes('【长期记忆】'), false, '复用会话时不应再注入长期记忆');
  assert.equal(prompt.includes('【成员画像】'), false, '复用会话时不应再注入成员画像');
  assert.equal(prompt.includes('大家约过三次爬山。'), false);
  assert.ok(prompt.includes('群名：爬山群'));
  assert.ok(prompt.includes('【最近对话】'));
  assert.ok(prompt.includes('M19'), '应保留最新消息');
  const conversation = prompt.split('【最近对话】')[1].split('【输出要求】')[0];
  const lines = conversation.trim().split('\n').filter((line) => line.startsWith('['));
  assert.equal(lines.length, 10, 'compact 模式最近对话只带 10 条');
  assert.ok(prompt.includes(SKIP_TOKEN));
  assert.ok(prompt.includes('不 @ 任何人'));
});

test('buildAmbientPrompt：最近对话最多 30 条，只保留最新部分', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    at: at(9, 0) + index * 1_000,
    senderName: '群友',
    text: `M${String(index + 1).padStart(2, '0')}`,
  }));
  const prompt = buildAmbientPrompt({ segmentMessages: messages });
  assert.equal(prompt.includes('M10'), false);
  assert.equal(prompt.includes('M01'), false);
  assert.ok(prompt.includes('M11'));
  assert.ok(prompt.includes('M40'));

  const conversation = prompt.split('【最近对话】')[1].split('【输出要求】')[0];
  const lines = conversation.trim().split('\n').filter((line) => line.startsWith('['));
  assert.equal(lines.length, 30);
});

test('buildAmbientPrompt：最近对话总字符数不超过 6000', () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    at: at(9, 0) + index * 1_000,
    senderName: `友${index}`,
    text: 'x'.repeat(1_000),
  }));
  const prompt = buildAmbientPrompt({ segmentMessages: messages });
  const conversation = prompt.split('【最近对话】')[1].split('【输出要求】')[0].trim();
  assert.ok(conversation.length > 0);
  assert.ok(conversation.length <= AMBIENT_MAX_CHARS, `对话段 ${conversation.length} 字符超限`);
});

test('buildAmbientPrompt：没有最近消息时给出占位说明', () => {
  const prompt = buildAmbientPrompt({});
  assert.ok(prompt.includes('【最近对话】'));
  assert.ok(prompt.includes('（暂无可用消息）'));
  assert.ok(prompt.includes(SKIP_TOKEN));
});

test('parseAmbientResult：[SKIP]/空/围栏包裹 → skip', () => {
  assert.deepEqual(parseAmbientResult(''), { skip: true, text: '' });
  assert.deepEqual(parseAmbientResult('   \n\t '), { skip: true, text: '' });
  assert.deepEqual(parseAmbientResult('[SKIP]'), { skip: true, text: '' });
  assert.deepEqual(parseAmbientResult(' [skip] '), { skip: true, text: '' });
  assert.deepEqual(parseAmbientResult('```\n[SKIP]\n```'), { skip: true, text: '' });
  assert.deepEqual(parseAmbientResult('[SKIP]（接不上）'), { skip: true, text: '' });
  assert.deepEqual(parseAmbientResult(123), { skip: true, text: '' });
});

test('parseAmbientResult：去围栏/引号，保留正文，超长截断到 200 字', () => {
  assert.deepEqual(parseAmbientResult('  那我也去  '), { skip: false, text: '那我也去' });
  assert.deepEqual(parseAmbientResult('```text\n那我也去\n```'), { skip: false, text: '那我也去' });
  assert.deepEqual(parseAmbientResult('"还没想好"'), { skip: false, text: '还没想好' });
  assert.deepEqual(parseAmbientResult('「一起呀」'), { skip: false, text: '一起呀' });

  const result = parseAmbientResult('字'.repeat(300));
  assert.equal(result.skip, false);
  assert.equal(Array.from(result.text).length, AMBIENT_REPLY_MAX_CHARS);
});

test('buildConsolidationPrompt：严格 JSON 契约与归纳限制写进提示词', () => {
  const prompt = buildConsolidationPrompt({
    groupName: '爬山群',
    memberIds: ['wx_a', 'wx_b'],
    segments: [{ messages: [{ at: at(9, 0), senderName: '阿明', text: '周六去爬山' }] }],
    previousMemory: '之前约过两次。',
    maxMemoryChars: 1_234,
    profileLimit: 3,
  });

  assert.ok(prompt.includes('爬山群'));
  assert.ok(prompt.includes('wx_a'));
  assert.ok(prompt.includes('之前约过两次。'));
  assert.ok(prompt.includes('周六去爬山'));
  assert.ok(prompt.includes('{"memory"'));
  assert.ok(prompt.includes('"relationshipNotes"'));
  assert.ok(prompt.includes('1234'));
  assert.ok(prompt.includes('3 个'));
  assert.ok(prompt.includes('不要推测隐私'));
});

test('parseConsolidationResult：容错字段类型并忽略额外字段', () => {
  const text = `说明文字\n\`\`\`json\n{"memory":" 大家喜欢爬山 ","profiles":[{"memberId":"wx_a","displayName":"阿明","summary":"组织者","traits":["热心",2,""],"interests":"爬山","speakingStyle":"话少","relationshipNotes":"老群友","extra":"ignored"}]}\n\`\`\``;
  const result = parseConsolidationResult(text);
  assert.equal(result.memory, '大家喜欢爬山');
  assert.deepEqual(result.profiles, [{
    memberId: 'wx_a',
    displayName: '阿明',
    summary: '组织者',
    traits: ['热心'],
    interests: [],
    speakingStyle: '话少',
    relationshipNotes: '老群友',
  }]);

  // 非数组 profiles → []；非字符串 memory → ''。
  assert.deepEqual(parseConsolidationResult('{"memory":123,"profiles":"x"}'), { memory: '', profiles: [] });

  // 非对象画像项被丢弃，缺失字段补默认值。
  assert.deepEqual(parseConsolidationResult('{"memory":"m","profiles":[null,5,{"traits":"x"}]}'), {
    memory: 'm',
    profiles: [{
      memberId: '',
      displayName: '',
      summary: '',
      traits: [],
      interests: [],
      speakingStyle: '',
      relationshipNotes: '',
    }],
  });
});

test('parseConsolidationResult：非法 JSON 抛 invalid consolidation result', () => {
  for (const text of ['不是 JSON', '{oops}', '[]', '', null]) {
    assert.throws(
      () => parseConsolidationResult(text),
      { message: 'invalid consolidation result' },
      `should reject ${JSON.stringify(text)}`,
    );
  }
});
