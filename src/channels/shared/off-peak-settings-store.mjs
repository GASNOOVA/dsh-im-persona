import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { DEFAULT_OFF_PEAK_SETTINGS, normalizeOffPeakSettings, shouldBlockInbound } from './off-peak.mjs';

const DOCUMENT_VERSION = 2;
const LEGACY_DOCUMENT_VERSION = 1;
const stores = new Map();

/**
 * 闲时启用是全局设置（微信与 QQ 共用），存放在 DSH home 下：
 * `<DSH_HOME>/integrations/dsh-im/off-peak-settings.json`。
 * 存储与 RPC、渠道运行时共用同一个单例，因此 UI 保存后运行时立即读到新值。
 */
export class OffPeakSettingsStore {
  #path;
  #settings = DEFAULT_OFF_PEAK_SETTINGS;
  #ready;
  #writes = Promise.resolve();

  constructor(path) { this.#path = path; }

  async get() {
    this.#ready ??= this.#load().catch((error) => {
      // 读取失败（如文件损坏）不应让设置页永远不可用：允许后续 set 覆盖修复。
      this.#ready = null;
      throw error;
    });
    await this.#ready;
    return {
      ...this.#settings,
      syncedHolidays: [...this.#settings.syncedHolidays],
    };
  }

  async #load() {
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const document = JSON.parse(raw);
    const settings = document.version === DOCUMENT_VERSION
      ? normalizeOffPeakSettings(document.offPeak)
      // v1 用 extraHolidays 表达用户手工补充的日期，迁移为 syncedHolidays。
      : document.version === LEGACY_DOCUMENT_VERSION
        ? normalizeOffPeakSettings({
          enabled: document.offPeak?.enabled,
          syncedHolidays: document.offPeak?.extraHolidays,
        })
        : null;
    if (!settings) throw new Error('Invalid off-peak settings document');
    // 迁移后的设置只驻留内存；下一次 set() 会以 v2 文档原子写回。
    this.#settings = settings;
  }

  async set(value) {
    const settings = normalizeOffPeakSettings(value);
    if (!settings) throw new TypeError('Invalid off-peak settings');
    const operation = this.#writes.catch(() => {}).then(async () => {
      // 先落定可能在途的读取，避免旧文件内容在写入后覆盖内存值；读取损坏时
      // 仍继续写入，让 UI 能通过保存一份合法文档完成修复。
      await this.get().catch(() => {});
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          `${JSON.stringify({ version: DOCUMENT_VERSION, offPeak: settings }, null, 2)}\n`,
          { mode: 0o600, flag: 'wx' },
        );
        await rename(temporary, this.#path);
        this.#settings = settings;
        this.#ready = Promise.resolve();
      } finally {
        await rm(temporary, { force: true });
      }
      return { ...settings, syncedHolidays: [...settings.syncedHolidays] };
    });
    this.#writes = operation;
    return operation;
  }

  /**
   * 同步读取缓存值，供入站消息热路径使用（不能等待磁盘）。
   * 尚未加载或加载失败时保持 false（fail-open：宁可照常响应，也不误静默）。
   */
  shouldBlockInbound(now = new Date()) {
    try {
      return shouldBlockInbound(this.#settings, now);
    } catch {
      return false;
    }
  }
}

/** One settings owner per DSH home, shared by the settings RPC and both channel runtimes. */
export function getOffPeakSettingsStore(config = {}) {
  const root = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const path = join(root, 'integrations', 'dsh-im', 'off-peak-settings.json');
  if (!stores.has(path)) stores.set(path, new OffPeakSettingsStore(path));
  return stores.get(path);
}
