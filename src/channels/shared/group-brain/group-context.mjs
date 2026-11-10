// 群聊上下文构建：直接@指令块、长期记忆/成员画像块、自动接话提示词、
// 记忆归纳提示词，以及两个模型输出的解析器。
//
// 本模块是纯函数集合（除 Date.now 默认参数外无副作用），不读写存储、不调用模型。
// 设计约定：
// - 注入给模型的「上下文块」用固定 XML 标签包裹，便于 Host 侧拆分与去重；
// - 块内用户可控文本里的同名标签字面量做 HTML 实体转义，避免伪造块边界；
// - 自动接话是一次性追加生成，不属于会进入会话历史的注入块，因此提示词是纯文本。

/** 自动接话时表示「这次不说」的标记。 */
export const SKIP_TOKEN = '[SKIP]';

/** 自动接话参考的最近消息条数上限。 */
export const AMBIENT_MAX_MESSAGES = 30;

/** 自动接话参考的最近消息总字符上限。 */
export const AMBIENT_MAX_CHARS = 6000;

/** 自动接话输出解析后的字符上限（超出截断）。 */
export const AMBIENT_REPLY_MAX_CHARS = 200;

/** 自动接话期望的中文长度（写进提示词，不强制截断）。 */
export const AMBIENT_REPLY_TARGET_CHARS = 80;

/** 记忆归纳提示词里对话片段的总字符上限（防止超长上下文）。 */
export const CONSOLIDATION_MAX_TRANSCRIPT_CHARS = 40_000;

const DIRECT_TAG = Object.freeze({
  open: '<dsh_im_direct_instruction>',
  close: '</dsh_im_direct_instruction>',
});

const GROUP_MEMORY_TAG = Object.freeze({
  open: '<dsh_im_group_memory>',
  close: '</dsh_im_group_memory>',
});

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInlineText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeBlockText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').trim();
}

/** 把文本里成对的块标签字面量转成 HTML 实体，避免提前闭合注入块。 */
function escapeTagLiterals(text, tag) {
  if (!text) return '';
  return String(text)
    .split(tag.open).join('&lt;' + tag.open.slice(1, -1) + '&gt;')
    .split(tag.close).join('&lt;' + tag.close.slice(1, -1) + '&gt;');
}

function stringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeInlineText(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    const text = normalizeInlineText(value);
    return text ? [text] : [];
  }
  return [];
}

function profileDisplayName(profile) {
  return normalizeInlineText(profile?.displayName)
    || normalizeInlineText(profile?.name)
    || normalizeInlineText(profile?.memberId)
    || '群成员';
}

function isCurrentSenderProfile(profile) {
  return profile?.isCurrentSender === true || profile?.current === true;
}

/** 渲染单条成员画像为一行（用于记忆块与接话提示词）。 */
function renderProfileLine(profile) {
  const name = profileDisplayName(profile);
  const summary = normalizeInlineText(profile.summary);
  const details = [];
  const traits = stringList(profile.traits);
  const interests = stringList(profile.interests);
  const speakingStyle = normalizeInlineText(profile.speakingStyle);
  const relationshipNotes = normalizeInlineText(profile.relationshipNotes);
  if (traits.length) details.push(`特征：${traits.join('、')}`);
  if (interests.length) details.push(`兴趣：${interests.join('、')}`);
  if (speakingStyle) details.push(`说话风格：${speakingStyle}`);
  if (relationshipNotes) details.push(`关系：${relationshipNotes}`);
  const summaryText = summary ? `：${summary}` : '';
  const detailText = details.length ? `（${details.join('；')}）` : '';
  return escapeTagLiterals(`- ${name}${summaryText}${detailText}`, GROUP_MEMORY_TAG);
}

/** 时间戳格式化为 HH:MM（本地时区）；非法时间用 --:-- 占位。 */
function formatClock(value) {
  if (!Number.isFinite(value)) return '--:--';
  const date = new Date(value);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function messageSenderName(message) {
  return normalizeInlineText(message?.senderName)
    || normalizeInlineText(message?.senderId)
    || '群友';
}

function messageText(message) {
  return normalizeInlineText(message?.text);
}

/** 单条会话消息渲染为 `[HH:MM] 名字：内容`。 */
function renderConversationLine(message) {
  if (!isPlainRecord(message)) return '';
  const text = messageText(message);
  if (!text) return '';
  return `[${formatClock(message.at)}] ${messageSenderName(message)}：${text}`;
}

/**
 * 直接 @ 指令块：告诉模型这条消息是明确点名请求，优先执行，并给出回复对象。
 * 群聊里 @ 消息本身也会走普通注入链路，这个块只补充「意图与优先级」。
 */
export function buildDirectInstructionBlock({ senderName = '' } = {}) {
  const name = normalizeInlineText(senderName) || '群成员';
  const body = [
    '这条群聊消息明确 @ 了你，是对你本人的直接请求，不是普通闲聊。',
    '优先级最高：请先明确、完整地执行这条请求；群聊氛围与人设只影响语气，不影响任务本身。',
    `回复对象：${name}。`,
  ].join('\n');
  return `${DIRECT_TAG.open}\n${body}\n${DIRECT_TAG.close}`;
}

/**
 * 长期记忆 + 成员画像块。
 *
 * 截断策略：整个块（含标签）不超过 maxChars；内容按「长期记忆 → 当前发送者画像 →
 * 其他画像」的优先级从后往前截断（写作顺序也按此排列，直接截尾即可保住高优先级）。
 * 两者都为空时返回空串，不注入无意义空块。
 */
export function buildGroupMemoryBlock({ memory = '', profiles = [], maxChars = 6000 } = {}) {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 6000;
  const memoryText = escapeTagLiterals(normalizeBlockText(memory), GROUP_MEMORY_TAG);
  const list = Array.isArray(profiles) ? profiles.filter(isPlainRecord) : [];
  const currentSender = list.filter(isCurrentSenderProfile);
  const others = list.filter((profile) => !isCurrentSenderProfile(profile));
  const orderedProfiles = [...currentSender, ...others];

  if (!memoryText && orderedProfiles.length === 0) return '';

  const sections = [];
  if (memoryText) sections.push(`## 长期记忆\n${memoryText}`);
  if (orderedProfiles.length) {
    sections.push(`## 成员画像\n${orderedProfiles.map(renderProfileLine).join('\n')}`);
  }

  const overhead = GROUP_MEMORY_TAG.open.length + GROUP_MEMORY_TAG.close.length + 2;
  const bodyBudget = limit - overhead;
  if (bodyBudget <= 0) return '';

  let body = sections.join('\n\n');
  if (body.length > bodyBudget) body = body.slice(0, bodyBudget);
  body = body.replace(/\s+$/, '');
  if (!body) return '';
  return `${GROUP_MEMORY_TAG.open}\n${body}\n${GROUP_MEMORY_TAG.close}`;
}

/**
 * 选取最近对话：先取最后 AMBIENT_MAX_MESSAGES 条，再从最新往前累计到
 * AMBIENT_MAX_CHARS 字符，最后恢复时间顺序。返回渲染后的行数组。
 */
function renderAmbientConversation(segmentMessages) {
  const messages = Array.isArray(segmentMessages) ? segmentMessages : [];
  const recent = messages.slice(-AMBIENT_MAX_MESSAGES);
  const lines = recent.map(renderConversationLine).filter(Boolean);

  const kept = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (kept.length === 0 && line.length > AMBIENT_MAX_CHARS) {
      // 单条消息就超上限：保留末尾（通常最新的信息在结尾附近）。
      kept.push(line.slice(-AMBIENT_MAX_CHARS));
      break;
    }
    if (total + line.length + (kept.length ? 1 : 0) > AMBIENT_MAX_CHARS) break;
    total += line.length + (kept.length ? 1 : 0);
    kept.push(line);
  }
  kept.reverse();
  return kept;
}

/**
 * 自动接话提示词：一次性追加生成请求。
 *
 * 传入的 persona 应是「已选中的群聊版人设全文」（例如 dafeiyu-group 的 text），
 * 本函数原样放入提示词，不做截断或改写。输出解析用 parseAmbientResult。
 */
export function buildAmbientPrompt({
  groupName = '',
  memberCount = null,
  segmentMessages = [],
  memory = '',
  profiles = [],
  persona = '',
  compact = false,
  now = Date.now(),
} = {}) {
  const lines = [];
  lines.push('你是这个群聊里的一名普通群友，不是客服、不是机器人助理。');
  lines.push('现在并没有人 @ 你，只是群聊安静下来了；你可以选择是否自然接一句。');
  if (compact) {
    lines.push('（完整的人设、长期记忆与成员画像已保存在本机群聊档案和当前会话历史中，这里只补充最近几条消息，避免重复占用 token。）');
  }
  lines.push('');

  const name = normalizeInlineText(groupName);
  if (name) lines.push(`群名：${name}`);
  if (Number.isFinite(memberCount) && memberCount > 0) {
    lines.push(`群规模：仅 ${Math.floor(memberCount)} 人小群，大家彼此比较熟悉。`);
  }

  if (!compact) {
    const personaText = typeof persona === 'string' ? persona.trim() : '';
    if (personaText) {
      lines.push('', '【你的身份（群聊版人设）】', personaText);
    }

    const memoryText = normalizeBlockText(memory);
    if (memoryText) {
      lines.push('', '【长期记忆】', memoryText);
    }

    const profileLines = (Array.isArray(profiles) ? profiles : [])
      .filter(isPlainRecord)
      .map(renderProfileLine);
    if (profileLines.length) {
      lines.push('', '【成员画像】', ...profileLines);
    }
  }

  lines.push('', '【最近对话】');
  const recent = compact ? segmentMessages.slice(-10) : segmentMessages;
  const conversation = renderAmbientConversation(recent);
  if (conversation.length) lines.push(...conversation);
  else lines.push('（暂无可用消息）');

  lines.push(
    '',
    '【输出要求】',
    '- 结合最近的话题自然接一句，像群友随口搭话；不要答非所问。',
    '- 只输出要发到群里的那一句话，不要解释、不要加引号、不要用 Markdown。',
    `- 中文不超过 ${AMBIENT_REPLY_TARGET_CHARS} 字；不 @ 任何人。`,
    '- 不复述、不总结上面的对话；不要连续发言或刷屏，这次接完就停。',
    `- 如果接不上、没兴趣或不确定该不该说，只输出 ${SKIP_TOKEN}。`,
  );
  void now;
  return lines.join('\n');
}

/** 去掉模型输出外层的 ``` 代码围栏（含语言标记与闭合围栏）。 */
function stripCodeFence(text) {
  let value = text.trim();
  if (!value.startsWith('```')) return value;
  value = value.slice(3);
  const newline = value.indexOf('\n');
  if (newline >= 0) {
    const firstLine = value.slice(0, newline).trim();
    if (/^[\w+-]*$/.test(firstLine)) value = value.slice(newline + 1);
  }
  const trimmedEnd = value.trimEnd();
  if (trimmedEnd.endsWith('```')) value = trimmedEnd.slice(0, -3);
  return value.trim();
}

const QUOTE_PAIRS = Object.freeze([
  ['"', '"'],
  ["'", "'"],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
  ['「', '」'],
  ['『', '』'],
]);

/** 去掉模型输出整体包裹的一对引号（中英文引号均支持）。 */
function stripWrappingQuotes(text) {
  const value = text.trim();
  if (value.length < 2) return value;
  for (const [open, close] of QUOTE_PAIRS) {
    if (value.startsWith(open) && value.endsWith(close)) {
      return value.slice(open.length, value.length - close.length).trim();
    }
  }
  return value;
}

/**
 * 解析自动接话输出：
 * - 空、`[SKIP]`（含代码围栏/引号包裹）→ {skip:true, text:''}；
 * - 其他文本去围栏/引号后返回；超过 200 字截断。
 * 列表、总结等格式不做过滤，由上层决定是否发送。
 */
export function parseAmbientResult(text) {
  let value = typeof text === 'string' ? text.trim() : '';
  if (!value) return { skip: true, text: '' };
  value = stripWrappingQuotes(stripCodeFence(value));
  if (!value) return { skip: true, text: '' };

  const upper = value.toUpperCase();
  if (upper === SKIP_TOKEN || upper.startsWith(SKIP_TOKEN)) {
    return { skip: true, text: '' };
  }

  if (Array.from(value).length > AMBIENT_REPLY_MAX_CHARS) {
    value = Array.from(value).slice(0, AMBIENT_REPLY_MAX_CHARS).join('');
  }
  return { skip: false, text: value };
}

/** 记忆归纳提示词里的对话片段渲染（兼容 {messages:[]} 与消息数组两种形状）。 */
function renderConsolidationSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const chunks = [];
  let total = 0;
  for (const segment of list) {
    const messages = Array.isArray(segment)
      ? segment
      : (isPlainRecord(segment) && Array.isArray(segment.messages) ? segment.messages : []);
    const lines = messages.map(renderConversationLine).filter(Boolean);
    if (!lines.length) continue;
    const chunk = lines.join('\n');
    if (total + chunk.length > CONSOLIDATION_MAX_TRANSCRIPT_CHARS) {
      const remain = CONSOLIDATION_MAX_TRANSCRIPT_CHARS - total;
      if (remain > 0) chunks.push(chunk.slice(0, remain));
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return chunks.join('\n\n');
}

/**
 * 长期记忆归纳提示词：要求模型只输出严格 JSON（memory + profiles）。
 *
 * segments 既可以是 `[{messages:[...]}, ...]`，也可以是消息数组的数组。
 * memberIds 作为画像 memberId 的白名单；profileLimit 与 maxMemoryChars 写进
 * 提示词由模型遵守，解析端不做强制裁剪（由上层按存储上限处理）。
 */
export function buildConsolidationPrompt({
  groupName = '',
  memberIds = [],
  segments = [],
  previousMemory = '',
  maxMemoryChars = 16_000,
  profileLimit = 5,
} = {}) {
  const name = normalizeInlineText(groupName);
  const ids = (Array.isArray(memberIds) ? memberIds : [])
    .map((id) => normalizeInlineText(id))
    .filter(Boolean);
  const memoryText = normalizeBlockText(previousMemory);
  const transcript = renderConsolidationSegments(segments);
  const memoryLimit = Number.isFinite(maxMemoryChars) ? Math.max(0, Math.floor(maxMemoryChars)) : 16_000;
  const profileMax = Number.isFinite(profileLimit) ? Math.max(0, Math.floor(profileLimit)) : 5;

  const lines = [
    '你在为群聊维护长期记忆与成员画像。',
    '请只根据下面实际发生过的对话做归纳：不要编造没出现过的事，不要推测隐私、真实身份或敏感属性。',
    '',
  ];
  if (name) lines.push(`群名：${name}`);
  if (ids.length) lines.push(`群成员 ID：${ids.join('、')}`);
  if (name || ids.length) lines.push('');
  lines.push('【已有长期记忆】');
  lines.push(memoryText || '（无）');
  lines.push('', '【本次新增对话】');
  lines.push(transcript || '（无）');
  lines.push(
    '',
    '【输出要求】',
    '- 只输出一个严格 JSON 对象，不要代码围栏，不要任何解释文字。',
    '- 结构：{"memory":"...","profiles":[{"memberId":"...","displayName":"...","summary":"...","traits":[],"interests":[],"speakingStyle":"...","relationshipNotes":"..."}]}',
    `- memory 是合并后的长期记忆，不超过 ${memoryLimit} 字；没有新信息就保留已有记忆。`,
    `- profiles 最多 ${profileMax} 个，只写有实际对话依据的成员。`,
    '- memberId 必须来自上面的群成员 ID；traits/interests 必须是字符串数组，没有信息就留空数组或空字符串。',
  );
  return lines.join('\n');
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}

/**
 * 解析记忆归纳输出：去围栏/取首尾大括号后 JSON.parse，字段类型容错。
 * 无法解析出合法 JSON 对象时抛 Error('invalid consolidation result')。
 */
export function parseConsolidationResult(text) {
  const raw = typeof text === 'string' ? text : '';
  const stripped = stripCodeFence(raw);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('invalid consolidation result');
  }
  let parsed;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    throw new Error('invalid consolidation result');
  }
  if (!isPlainRecord(parsed)) throw new Error('invalid consolidation result');

  const memory = typeof parsed.memory === 'string' ? parsed.memory.trim() : '';
  const profiles = Array.isArray(parsed.profiles)
    ? parsed.profiles.filter(isPlainRecord).map((profile) => ({
      memberId: typeof profile.memberId === 'string' ? profile.memberId.trim() : '',
      displayName: typeof profile.displayName === 'string' ? profile.displayName.trim() : '',
      summary: typeof profile.summary === 'string' ? profile.summary.trim() : '',
      traits: normalizeStringList(profile.traits),
      interests: normalizeStringList(profile.interests),
      speakingStyle: typeof profile.speakingStyle === 'string' ? profile.speakingStyle.trim() : '',
      relationshipNotes: typeof profile.relationshipNotes === 'string' ? profile.relationshipNotes.trim() : '',
    }))
    : [];
  return { memory, profiles };
}
