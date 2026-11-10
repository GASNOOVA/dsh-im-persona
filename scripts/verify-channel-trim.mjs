#!/usr/bin/env node
// Static acceptance scan for the personal edition's channel trim.
//
// The personal edition keeps only the Weixin (weixin) and QQ (qq) channels. This
// script is the machine-checkable part of that promise:
//
//   1. Every relative import/export specifier in the scanned source resolves to a
//      file that exists (no dangling import left behind by a deleted channel).
//   2. No production source mentions a removed channel identifier outside a
//      comment (comments are allowed to explain the removal; docs/README/
//      package.json/locale are owned by other tasks and skipped).
//   3. The Weixin + QQ registration chain is present end to end: channel
//      directories, host startup imports, client tab ids and their display order
//      (Weixin first, then QQ).
//
// Usage:
//   node scripts/verify-channel-trim.mjs           # fail on production leftovers
//   node scripts/verify-channel-trim.mjs --tests   # additionally scan test/ (warnings only)
//
// No dependencies: this must run in the bare repo without `npm install`.

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const self = relative(root, resolve(import.meta.filename));
const includeTests = process.argv.includes('--tests');

const REMOVED_CHANNELS = [
  'dingtalk', 'discord', 'email', 'feishu', 'imessage', 'matrix',
  'office', 'slack', 'telegram', 'wecom', 'wecom-app', 'whatsapp',
];
const KEPT_CHANNELS = ['weixin', 'qq'];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'lib']);
// Owned by the personalization task, not by the channel trim: the brand sweep
// rewrites these, so the trim scan must not fail on their pre-brand state.
const SKIP_BRAND_SCAN = new Set([
  'package.json',
  'README.md',
  'README.en.md',
  'cordis.patch.yml',
]);
const SKIP_BRAND_PREFIXES = ['locale/', 'bin/', 'docs/', 'PROACTIVE_DELIVERY', 'THIRD_PARTY'];

const failures = [];
const warnings = [];
const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...await walk(resolve(directory, entry.name)));
    } else if (entry.isFile()) {
      files.push(resolve(directory, entry.name));
    }
  }
  return files;
}

const sourceFiles = (await walk(root))
  .filter((path) => /\.(mjs|js)$/u.test(path))
  .filter((path) => {
    const rel = relative(root, path).split('\\').join('/');
    // Build entry points and fixtures are scanned for imports; the brand scan
    // covers the code that ships.
    return rel !== self;
  });

function isBrandScannable(relPath) {
  if (SKIP_BRAND_SCAN.has(relPath)) return false;
  if (SKIP_BRAND_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false;
  if (relPath.startsWith('test/')) return includeTests;
  return true;
}

/**
 * Replace comments with spaces while preserving string/template contents, so a
 * channel name mentioned only in an explanatory comment does not fail the scan.
 * Newlines are kept so line numbers still line up.
 */
function stripComments(source) {
  let output = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      output += '  ';
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    output += char;
  }
  return output;
}

// Brand identifiers of the removed channels. Word boundaries keep MIME types
// (`...officedocument...`) and unrelated words out; WeCom's hyphenated channel
// key is caught by the `wecom` word itself.
const BRAND_PATTERN = /\b(dingtalk|discord|feishu|imessage|matrix|office|slack|telegram|wecom|whatsapp|email)\b/i;
const BRAND_CHINESE = /飞书|钉钉|企业微信|邮箱|邮件/;
// Comments and docs may legitimately explain the removal; the files below are
// new documentation written by this task and quote the removed names on purpose.
const ALLOWED_BRAND_MENTIONS = new Map([
  ['scripts/verify-channel-trim.mjs', /./u], // the scan itself
]);

// --- 1. Kept channel registration chain -------------------------------------
const requiredPaths = [
  ...KEPT_CHANNELS.map((channel) => `src/channels/${channel}`),
  ...KEPT_CHANNELS.map((channel) => `plugin-src/host/channels/${channel}`),
  ...KEPT_CHANNELS.map((channel) => `plugin-src/client/channels/${channel}`),
  'src/channels/shared/i18n-en.mjs',
  'src/channels/shared/i18n-ru.mjs',
  'plugin-src/host/index.mjs',
  'plugin-src/client/index.js',
  'plugin-src/client/im-channels.js',
];
for (const path of requiredPaths) {
  try {
    const info = await stat(resolve(root, path));
    if (!info.isDirectory() && !info.isFile()) fail(`required path is not a file or directory: ${path}`);
  } catch {
    fail(`required path is missing: ${path}`);
  }
}

for (const channel of REMOVED_CHANNELS) {
  for (const base of ['src/channels', 'plugin-src/host/channels', 'plugin-src/client/channels', 'test/channels']) {
    try {
      await stat(resolve(root, base, channel));
      // Shared modules keep the former channel name only in comments; a directory
      // is a real leftover.
      if (base !== 'test/channels') fail(`removed channel directory still exists: ${base}/${channel}`);
    } catch {
      // expected: the directory is gone
    }
  }
}

const hostIndex = await readFile(resolve(root, 'plugin-src/host/index.mjs'), 'utf8');
for (const channel of KEPT_CHANNELS) {
  if (!hostIndex.includes(`./channels/${channel}/index.mjs`)) {
    fail(`plugin-src/host/index.mjs does not import the ${channel} host channel`);
  }
}
const clientIndex = await readFile(resolve(root, 'plugin-src/client/index.js'), 'utf8');
const weixinIndex = clientIndex.indexOf("id: 'weixin'");
const qqIndex = clientIndex.indexOf("id: 'qq'");
if (weixinIndex === -1 || qqIndex === -1) {
  fail('plugin-src/client/index.js does not register both weixin and qq tabs');
} else if (weixinIndex > qqIndex) {
  fail('channel tab order must be Weixin first, then QQ');
}

// --- 2. No dangling relative imports ----------------------------------------
const IMPORT_PATTERN = /^\s*(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+)['"]([^'"]+)['"]/gmu;
async function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.json`,
    resolve(base, 'index.mjs'),
    resolve(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return true;
    } catch {
      // keep trying
    }
  }
  return false;
}

let importCount = 0;
for (const file of sourceFiles) {
  const relPath = relative(root, file).split('\\').join('/');
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    // `lib/` is the generated bundle directory: acceptance scripts import it and
    // it does not exist in a bare checkout (no build here), so it is not a
    // dangling source import.
    if (specifier.includes('lib/')) continue;
    importCount += 1;
    if (!await resolveRelative(file, specifier)) {
      fail(`dangling relative import in ${relPath}: ${specifier}`);
    }
  }
  if (!relPath.startsWith('test/') || includeTests) {
    const stripped = stripComments(source);
    const allowed = ALLOWED_BRAND_MENTIONS.get(relPath);
    if (!allowed && isBrandScannable(relPath)) {
      const isTest = relPath.startsWith('test/');
      const lines = stripped.split('\n');
      lines.forEach((line, lineIndex) => {
        if (BRAND_PATTERN.test(line) || BRAND_CHINESE.test(line)) {
          const message = `removed channel identifier in ${relPath}:${lineIndex + 1}: ${line.trim().slice(0, 140)}`;
          // Tests are a follow-up cleanup item: many still use removed channels
          // as generic fixtures. They are reported (and can be cleaned without
          // affecting production), but they must not hide a production leftover.
          if (isTest) warn(message);
          else fail(message);
        }
      });
    }
  }
}

// --- 3. Aggregation files only mention kept channels ------------------------
const i18nEn = await readFile(resolve(root, 'src/channels/shared/i18n-en.mjs'), 'utf8');
const i18nRu = await readFile(resolve(root, 'src/channels/shared/i18n-ru.mjs'), 'utf8');
for (const [label, source] of [['i18n-en.mjs', i18nEn], ['i18n-ru.mjs', i18nRu]]) {
  for (const channel of REMOVED_CHANNELS) {
    if (new RegExp(`i18n-(?:en|ru)/${channel}\\.mjs`, 'u').test(source)) {
      fail(`${label} still imports the removed ${channel} dictionary`);
    }
  }
  for (const channel of KEPT_CHANNELS) {
    if (!source.includes(`./i18n-${label.startsWith('i18n-en') ? 'en' : 'ru'}/${channel}.mjs`)) {
      fail(`${label} does not merge the kept ${channel} dictionary`);
    }
  }
}

// --- 4. package.json dependency advice (report only; the brand task owns it) -
try {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const declared = Object.keys(manifest.dependencies ?? {});
  const allowedRuntime = new Set([
    '@tencent-connect/qqbot-connector',
    '@tencent-connect/qqbot-nodejs',
    'qrcode',
    'undici',
  ]);
  for (const name of declared) {
    if (!allowedRuntime.has(name)) {
      warn(`package.json still declares a dependency from a removed channel: ${name} (brand task removes it)`);
    }
  }
} catch (error) {
  warn(`could not read package.json: ${error?.message ?? error}`);
}

// --- Report ----------------------------------------------------------------
console.log(`Scanned ${sourceFiles.length} source files and ${importCount} relative imports.`);
if (warnings.length) {
  console.log(`\nWarnings (${warnings.length}):`);
  for (const message of warnings) console.log(`  ! ${message}`);
}
if (failures.length) {
  console.error(`\nFAILED: ${failures.length} channel-trim violation(s):`);
  for (const message of failures) console.error(`  ✖ ${message}`);
  process.exit(1);
}
console.log('\nChannel trim verified: Weixin + QQ only, no dangling imports, no removed-channel identifiers in production source.');
