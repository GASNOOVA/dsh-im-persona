#!/usr/bin/env node
/**
 * dsh-im-persona —— 个人定制版安装器
 * ============================================================================
 * 用一条命令把本插件装进指定 DSH profile，并提示重启方式。
 * 只处理自己的包，不再迁移旧版独立渠道插件（个人版已不再兼容那些包）。
 */
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGE_NAME = 'dsh-im-persona';
const DEFAULT_SOURCE = 'github:GASNOOVA/dsh-im-persona';

function usage() {
  console.log(`Usage:
  dsh-im-persona install [--profile web] [--source <package-spec>]
  dsh-im-persona uninstall [--profile web]

Examples:
  npx -y github:GASNOOVA/dsh-im-persona install
  dsh-im-persona install --source .`);
}

function takeOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function runDsh(args) {
  const result = spawnSync('dsh', args, {
    cwd: tmpdir(),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error('找不到 dsh，请先安装 DeepSeek Harness 并确保 dsh 在 PATH 中。');
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`dsh 退出，状态码 ${result.status ?? 1}`);
}

function resolveSource(requested) {
  if (requested === '.' || requested === '..'
    || requested.startsWith('./') || requested.startsWith('../')) {
    return resolve(process.cwd(), requested);
  }
  return isAbsolute(requested) ? requested : requested;
}

const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(0);
}

try {
  const profile = takeOption(args, '--profile', 'web');
  if (command === 'install') {
    const source = resolveSource(takeOption(args, '--source', DEFAULT_SOURCE));
    if (args.length > 0) throw new Error(`无法识别的参数：${args.join(' ')}`);
    runDsh(['plugin', '--profile', profile, 'add', '--save-exact', source]);
    console.log('\n个人版 IM 机器人插件已安装。请重启 dsh web、刷新浏览器，然后打开「设置 → IM机器人」。');
  } else if (command === 'uninstall') {
    if (args.length > 0) throw new Error(`无法识别的参数：${args.join(' ')}`);
    runDsh(['plugin', '--profile', profile, 'remove', PACKAGE_NAME]);
    console.log('\n个人版 IM 机器人插件已卸载。请重启 dsh web。');
  } else {
    throw new Error(`无法识别的命令：${command}`);
  }
} catch (error) {
  console.error(`dsh-im-persona: ${error.message}`);
  process.exit(1);
}
