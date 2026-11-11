// B 站翻唱指令解析。
//
// 指令格式（群聊）：引用一条消息 + 文本里带 B 站视频链接 + 可选翻唱要求提示词。
//   @大肥鱼 翻唱 https://www.bilibili.com/video/BV1xx411c7mD
//   @大肥鱼 翻唱 https://b23.tv/xxxx 用可爱一点的语气，混音版
//
// 规则：
// - 必须出现「翻唱」关键词与 B 站链接，否则不当作翻唱指令；
// - 提示词中明确出现「混音 / 带伴奏 / 伴奏版」才走混音，否则默认纯人声；
// - 指令由 bridge 在「这条消息引用了某条消息」时才会执行，避免误触发。

const BILIBILI_URL_RE =
  /https?:\/\/(?:(?:www|m)\.)?bilibili\.com\/video\/(?:BV[0-9A-Za-z]+|av\d+)[^\s<>"']*/i;
const SHORT_URL_RE = /https?:\/\/b23\.tv\/[0-9A-Za-z]+[^\s<>"']*/i;
const MIX_RE = /混音|带伴奏|伴奏版|伴奏/i;
const COVER_KEYWORD_RE = /翻唱/;

/** 从文本中提取第一个 B 站视频链接；没有则返回空字符串。 */
export function findBilibiliUrl(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const match = text.match(BILIBILI_URL_RE) || text.match(SHORT_URL_RE);
  return match ? match[0].replace(/[),.;，。；）]+$/, '') : '';
}

/** 判断文本是否包含翻唱关键词。 */
export function isCoverCommandText(text) {
  return typeof text === 'string' && COVER_KEYWORD_RE.test(text) && Boolean(findBilibiliUrl(text));
}

/**
 * 解析翻唱指令。
 *
 * 链接可以出现在命令正文里，也可以来自被引用的消息（用户习惯：引用一条
 * 链接卡片/链接消息，再发一句「翻唱 + 要求」），或同一群里最近出现过的
 * B 站链接（fallbackUrl，由桥接层按时间窗口提供）。
 *
 * @returns {{url:string, prompt:string, mix:boolean}|null}
 */
export function parseCoverCommand(text, { maxPromptChars = 300, quotedText = '', fallbackUrl = '' } = {}) {
  if (typeof text !== 'string') return null;
  const raw = text.replace(/\s+/g, ' ').trim();
  if (!raw || !COVER_KEYWORD_RE.test(raw)) return null;
  const url = findBilibiliUrl(raw) || findBilibiliUrl(quotedText) || findBilibiliUrl(fallbackUrl);
  if (!url) return null;
  let prompt = raw
    .replace(url, ' ')
    .replace(COVER_KEYWORD_RE, ' ')
    .replace(/@[^\s]+/g, ' ')
    .replace(/^\s*(?:帮我|请|给我|帮忙)?\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[，,。.;；、:：\s]+|[，,。.;；、:：\s]+$/g, '')
    .trim();
  const limit = Number.isInteger(maxPromptChars) && maxPromptChars > 0 ? maxPromptChars : 300;
  if (prompt.length > limit) prompt = prompt.slice(0, limit);
  return { url, prompt, mix: MIX_RE.test(prompt) };
}
