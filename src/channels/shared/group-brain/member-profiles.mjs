// 群聊成员画像：从群消息里累积每个成员的稳定观察，供群聊大脑组装 prompt。
//
// 这里只做「观察的归并与裁剪」：不做身份推断、不猜敏感信息（性别、年龄、住址等），
// 字段内容由上游模型基于群内明确说过的内容给出；本模块负责限制长度、去重、合并，
// 并把结果格式化成一行中文提示词。渠道无关：微信群与 QQ 群使用同一套画像结构。

/** 画像各字段上限；与 group-brain-config 的 profiles.maxProfiles（人数上限）配合使用。 */
export const PROFILE_LIMITS = Object.freeze({
  displayName: 60,
  summary: 400,
  traits: 6,
  interests: 6,
  speakingStyle: 200,
  relationshipNotes: 400,
});

/** 单个 trait / interest 的最大长度：画像要能塞进一行 prompt。 */
const ITEM_MAX_CHARS = 80;

/** memberId 上限：QQ openid / 微信 userId 都不会这么长，纯防脏数据。 */
const MEMBER_ID_MAX_CHARS = 200;

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * 归一化一段自由文本：折叠空白、去首尾、按「字符」而非 UTF-16 码元截断。
 * 非字符串一律返回空串，让调用方用 `|| 已有值` 的方式安全合并。
 */
export function truncateText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const max = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 0;
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  if (!collapsed || max === 0) return '';
  const chars = [...collapsed];
  return chars.length > max ? chars.slice(0, max).join('') : collapsed;
}

/**
 * 去重后的字符串数组：保留首次出现的顺序，丢弃空值与非字符串，最多 maxCount 条。
 * 用于 traits / interests 的并集合并。
 */
export function uniqueStrings(values, maxCount = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(values)) return [];
  const count = Number.isSafeInteger(maxCount) && maxCount >= 0
    ? maxCount
    : Number.POSITIVE_INFINITY;
  if (count === 0) return [];
  const seen = new Set();
  const result = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const text = raw.replace(/\s+/gu, ' ').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= count) break;
  }
  return result;
}

/** 空画像：第一次看到某个成员时使用。 */
export function createEmptyProfile(memberId, { displayName = '', at = Date.now() } = {}) {
  const id = truncateText(memberId, MEMBER_ID_MAX_CHARS);
  if (!id) throw new TypeError('member id is required');
  const when = numberOrNull(at) ?? Math.trunc(Date.now());
  return {
    memberId: id,
    displayName: truncateText(displayName, PROFILE_LIMITS.displayName),
    summary: '',
    traits: [],
    interests: [],
    speakingStyle: '',
    relationshipNotes: '',
    firstSeenAt: when,
    lastSeenAt: when,
  };
}

/**
 * 把任意来源（磁盘上的旧画像、模型输出）转成合法画像；缺 memberId 或不是对象时
 * 返回 null，由调用方决定跳过。长度与条数在这里统一收敛。
 */
export function normalizeMemberProfile(value) {
  if (!isPlainRecord(value)) return null;
  const memberId = truncateText(value.memberId, MEMBER_ID_MAX_CHARS);
  if (!memberId) return null;
  return {
    memberId,
    displayName: truncateText(value.displayName, PROFILE_LIMITS.displayName),
    summary: truncateText(value.summary, PROFILE_LIMITS.summary),
    traits: uniqueStrings(value.traits, PROFILE_LIMITS.traits),
    interests: uniqueStrings(value.interests, PROFILE_LIMITS.interests),
    speakingStyle: truncateText(value.speakingStyle, PROFILE_LIMITS.speakingStyle),
    relationshipNotes: truncateText(value.relationshipNotes, PROFILE_LIMITS.relationshipNotes),
    firstSeenAt: numberOrNull(value.firstSeenAt),
    lastSeenAt: numberOrNull(value.lastSeenAt),
  };
}

function pickText(updateValue, currentValue, maxLength) {
  const text = truncateText(updateValue, maxLength);
  return text || currentValue;
}

/**
 * 合并一次画像更新：
 * - 文本字段只有「本次更新非空」才覆盖（模型偶尔给空字段不应清空已积累的观察）；
 * - traits / interests 做并集去重并截断条数；
 * - 保留 firstSeenAt，lastSeenAt 更新为现在；
 * - 两个参数都缺失 memberId 时返回 null（由调用方跳过）。
 */
export function mergeMemberProfile(existing, update, { now = Date.now() } = {}) {
  const base = normalizeMemberProfile(existing);
  const patch = isPlainRecord(update) ? update : {};
  const memberId = truncateText(patch.memberId ?? base?.memberId, MEMBER_ID_MAX_CHARS);
  if (!memberId) return null;
  const when = numberOrNull(now) ?? Math.trunc(Date.now());
  const firstSeenAt = base?.firstSeenAt ?? numberOrNull(patch.firstSeenAt) ?? when;
  return {
    memberId,
    displayName: pickText(patch.displayName, base?.displayName ?? '', PROFILE_LIMITS.displayName),
    summary: pickText(patch.summary, base?.summary ?? '', PROFILE_LIMITS.summary),
    traits: uniqueStrings(
      [...(base?.traits ?? []), ...(Array.isArray(patch.traits) ? patch.traits : [])]
        .map((item) => truncateText(item, ITEM_MAX_CHARS)),
      PROFILE_LIMITS.traits,
    ),
    interests: uniqueStrings(
      [...(base?.interests ?? []), ...(Array.isArray(patch.interests) ? patch.interests : [])]
        .map((item) => truncateText(item, ITEM_MAX_CHARS)),
      PROFILE_LIMITS.interests,
    ),
    speakingStyle: pickText(patch.speakingStyle, base?.speakingStyle ?? '', PROFILE_LIMITS.speakingStyle),
    relationshipNotes: pickText(
      patch.relationshipNotes,
      base?.relationshipNotes ?? '',
      PROFILE_LIMITS.relationshipNotes,
    ),
    firstSeenAt,
    lastSeenAt: Math.max(when, base?.lastSeenAt ?? 0),
  };
}

/**
 * 单行中文 prompt 文本。只拼接已保存的观察，不做任何推断或补充标签。
 * 返回空串表示这个画像没有可展示内容。
 */
export function formatMemberProfile(profile) {
  const normalized = normalizeMemberProfile(profile);
  if (!normalized) return '';
  const parts = [`成员 ${normalized.displayName || normalized.memberId}`];
  if (normalized.traits.length) parts.push(`性格 ${normalized.traits.join('、')}`);
  if (normalized.interests.length) parts.push(`兴趣 ${normalized.interests.join('、')}`);
  if (normalized.speakingStyle) parts.push(`说话风格 ${normalized.speakingStyle}`);
  if (normalized.relationshipNotes) parts.push(`关系 ${normalized.relationshipNotes}`);
  if (normalized.summary) parts.push(`简介 ${normalized.summary}`);
  return parts.join('；');
}

function cloneProfile(profile) {
  return structuredClone(profile);
}

/**
 * 群体画像集合：负责加载/保存/上限裁剪，底层通过 GroupBrainStore 的
 * getProfiles()/saveProfiles() 持久化。`maxProfiles` 是人数上限，超出时按
 * lastSeenAt 最近的保留。
 */
export class GroupMemberProfiles {
  #store;
  #maxProfiles;
  #now;
  #profiles = new Map();
  #ready = null;

  constructor({ store, maxProfiles = 5, now = Date.now } = {}) {
    if (!store || typeof store.getProfiles !== 'function' || typeof store.saveProfiles !== 'function') {
      throw new TypeError('a group brain store with getProfiles/saveProfiles is required');
    }
    this.#store = store;
    this.#maxProfiles = Number.isSafeInteger(maxProfiles) && maxProfiles > 0 ? maxProfiles : 5;
    this.#now = typeof now === 'function' ? now : Date.now;
  }

  /** 加载磁盘画像；损坏内容由存储层 fail-soft，这里再做一次形状过滤。 */
  async load() {
    this.#ready ??= this.#load().catch((error) => {
      this.#ready = null;
      throw error;
    });
    await this.#ready;
    return this;
  }

  async #load() {
    let stored;
    try {
      stored = await this.#store.getProfiles();
    } catch {
      stored = null;
    }
    const entries = isPlainRecord(stored) ? stored : {};
    this.#profiles.clear();
    for (const value of Object.values(entries)) {
      const profile = normalizeMemberProfile(value);
      if (profile) this.#profiles.set(profile.memberId, profile);
    }
    this.#prune(this.#maxProfiles);
  }

  /** 当前已知成员数（加载后即准确；构造时为 0）。 */
  get size() {
    return this.#profiles.size;
  }

  /** 按最近出现时间倒序的画像副本；同时间按 memberId 排序保证可重复。 */
  list() {
    return [...this.#profiles.values()]
      .sort((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0)
        || left.memberId.localeCompare(right.memberId))
      .map(cloneProfile);
  }

  get(memberId) {
    const id = truncateText(memberId, MEMBER_ID_MAX_CHARS);
    if (!id) return null;
    const profile = this.#profiles.get(id);
    return profile ? cloneProfile(profile) : null;
  }

  /** 合并一个成员的更新；返回合并后的画像（无效更新返回 null）。 */
  async upsert(update) {
    const merged = await this.upsertMany([update]);
    return merged[0] ?? null;
  }

  /** 批量合并，只写一次磁盘；返回本次实际合并成功的画像列表。 */
  async upsertMany(updates) {
    await this.load();
    if (!Array.isArray(updates)) throw new TypeError('profile updates must be an array');
    const now = this.#now();
    const merged = [];
    for (const update of updates) {
      const patch = isPlainRecord(update) ? update : null;
      if (!patch) continue;
      const memberId = truncateText(patch.memberId, MEMBER_ID_MAX_CHARS);
      if (!memberId) continue;
      const profile = mergeMemberProfile(this.#profiles.get(memberId) ?? null, patch, { now });
      if (!profile) continue;
      this.#profiles.set(memberId, profile);
      merged.push(cloneProfile(profile));
    }
    if (!merged.length) return merged;
    this.#prune(this.#maxProfiles);
    await this.#persist();
    return merged;
  }

  /** 显式收紧人数上限（例如配置从 5 改为 3）：按 lastSeenAt 保留最近的。 */
  async pruneTo(maxProfiles) {
    if (!Number.isSafeInteger(maxProfiles) || maxProfiles <= 0) {
      throw new TypeError('maxProfiles must be a positive integer');
    }
    await this.load();
    this.#maxProfiles = maxProfiles;
    const removed = this.#prune(maxProfiles);
    if (removed.length) await this.#persist();
    return { removed, size: this.#profiles.size };
  }

  /** 删除 lastSeenAt 最早的成员，直到不超过 limit；返回被删 id。 */
  #prune(limit) {
    const removed = [];
    if (this.#profiles.size <= limit) return removed;
    const ordered = [...this.#profiles.values()].sort((left, right) =>
      (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0)
      || left.memberId.localeCompare(right.memberId));
    for (const profile of ordered.slice(limit)) {
      this.#profiles.delete(profile.memberId);
      removed.push(profile.memberId);
    }
    return removed;
  }

  async #persist() {
    const profiles = {};
    for (const [memberId, profile] of this.#profiles) profiles[memberId] = cloneProfile(profile);
    await this.#store.saveProfiles(profiles);
  }
}
