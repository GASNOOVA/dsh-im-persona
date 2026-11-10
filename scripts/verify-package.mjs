import { access, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

async function readSourceTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readSourceTree(path));
    } else if (entry.isFile() && /\.m?js$/u.test(entry.name)) {
      chunks.push(await readFile(path, 'utf8'));
    }
  }
  return chunks.join('\n');
}

const required = [
  'lib/index.js',
  'lib/client.js',
  'bin/dsh-im-persona.mjs',
  'cordis.patch.yml',
  'scripts/verify-injected-context.mjs',
  'README.md',
  'PROACTIVE_DELIVERY.md',
  'THIRD_PARTY_NOTICES.md',
  'plugin-src/client/channels/qq/index.js',
  'plugin-src/client/channels/weixin/index.js',
  'plugin-src/client/i18n.js',
  'plugin-src/client/context-enhancement.js',
  'plugin-src/host/channels/qq/index.mjs',
  'plugin-src/host/channels/weixin/index.mjs',
  'src/channels/qq/qq-runtime.mjs',
  'src/channels/weixin/weixin-runtime.mjs',
  'src/channels/shared/context-enhancement.mjs',
];
await Promise.all(required.map((path) => access(resolve(root, path))));

const [
  client,
  host,
  patch,
  manifestText,
  lockText,
  hostSource,
  clientEntrySource,
  clientSources,
  executable,
] = await Promise.all([
  readFile(resolve(root, 'lib/client.js'), 'utf8'),
  readFile(resolve(root, 'lib/index.js'), 'utf8'),
  readFile(resolve(root, 'cordis.patch.yml'), 'utf8'),
  readFile(resolve(root, 'package.json'), 'utf8'),
  readFile(resolve(root, 'package-lock.json'), 'utf8'),
  readFile(resolve(root, 'plugin-src/host/index.mjs'), 'utf8'),
  readFile(resolve(root, 'plugin-src/client/index.js'), 'utf8'),
  readSourceTree(resolve(root, 'plugin-src/client')),
  stat(resolve(root, 'bin/dsh-im-persona.mjs')),
]);
const manifest = JSON.parse(manifestText);
const lock = JSON.parse(lockText);

// DSH runtime packages use module-local Symbol keys, so a second physical copy breaks Host lookup.
const forbiddenDshDependency = /^@deepseek-ai\/dsh-/;
const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
for (const section of dependencySections) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (forbiddenDshDependency.test(name)) {
      throw new Error(
        `${name} must not be declared in ${section}; DSH runtime packages must come from the host`,
      );
    }
  }
}
const bundledDependencies = manifest.bundleDependencies ?? manifest.bundledDependencies ?? [];
if (Array.isArray(bundledDependencies)) {
  for (const name of bundledDependencies) {
    if (forbiddenDshDependency.test(name)) {
      throw new Error(`${name} must not be bundled; DSH runtime packages must come from the host`);
    }
  }
}
const forbiddenDshLockPaths = Object.keys(lock.packages ?? {}).filter((path) => (
  /(?:^|\/)node_modules\/@deepseek-ai\/dsh-[^/]+(?:\/|$)/.test(path)
));
if (forbiddenDshLockPaths.length > 0) {
  throw new Error(
    `package lock must not install DSH runtime packages: ${forbiddenDshLockPaths.join(', ')}`,
  );
}

if (!/\bid\s*:\s*["']dsh-im-persona["']/u.test(client)) {
  throw new Error('client bundle does not register the dsh-im-persona loader id');
}
const sourceSectionMarkers = [
  /ctx\.slots\.inject\(\s*["']settings\.section["']/u,
  /name\s*:\s*["']settings\.section["']/u,
  /id\s*:\s*["']dsh-im-persona["']/u,
  /order\s*:\s*21\b/u,
  /label\s*:\s*\(\)\s*=>\s*t\(\s*["']IM机器人["']\s*\)/u,
  /locale\s*:\s*IM_LOCALE_NAMESPACE\b/u,
];
const bundleSectionPattern = /name\s*:\s*["']settings\.section["']\s*,\s*id\s*:\s*["']dsh-im-persona["']\s*,\s*order\s*:\s*21\s*,\s*label\s*:\s*\(\)\s*=>\s*[$A-Z_a-z][$\w]*\(\s*["']IM(?:机器人|\\u673A\\u5668\\u4EBA)["']\s*\)\s*,\s*locale\s*:\s*(?:[$A-Z_a-z][$\w]*|["']dsh-im-persona["'])/u;
if (sourceSectionMarkers.some((pattern) => !pattern.test(clientEntrySource))
  || !/IM_LOCALE_NAMESPACE\s*=\s*["']dsh-im-persona["']/u.test(clientSources)
  || !bundleSectionPattern.test(client)) {
  throw new Error('client bundle does not register the localized top-level IM settings section');
}
if ((client.match(/\.slots\.inject\(\s*["']settings\.section["']/gu) ?? []).length !== 1) {
  throw new Error('client bundle must register exactly one top-level settings section');
}
if (client.includes('settings.plugins.tab') || clientSources.includes('settings.plugins.tab')) {
  throw new Error('client source or bundle still contains the legacy Plugins-tab settings entry');
}
// Connections still have no channel-enable toggle. Checkable inputs are owned
// only by the shared context editor, the saved-target Session sync row, the
// conversation-directory settings form, the general Delivery tab, and the
// off-peak-only toggle in General settings.
const contextEditorSource = await readFile(resolve(root, 'plugin-src/client/context-enhancement.js'), 'utf8');
const deliverySettingsSource = await readFile(resolve(root, 'plugin-src/client/delivery-settings.js'), 'utf8');
const botGeneralSettingsSource = await readFile(resolve(root, 'plugin-src/client/bot-general-settings.js'), 'utf8');
const deliverySyncSettingsSource = await readFile(
  resolve(root, 'plugin-src/client/delivery-sync-settings.js'),
  'utf8',
);
const personaSettingsSource = await readFile(resolve(root, 'plugin-src/client/persona-settings.js'), 'utf8');
const offPeakSettingsSource = await readFile(resolve(root, 'plugin-src/client/off-peak-settings.js'), 'utf8');
const groupBrainSettingsSource = await readFile(resolve(root, 'plugin-src/client/group-brain-settings.js'), 'utf8');
const otherClientSources = clientSources
  .replace(contextEditorSource, '')
  .replace(deliverySettingsSource, '')
  .replace(botGeneralSettingsSource, '')
  .replace(deliverySyncSettingsSource, '')
  .replace(personaSettingsSource, '')
  .replace(offPeakSettingsSource, '')
  .replace(groupBrainSettingsSource, '');
if (/role:\s*["']switch|type:\s*["']checkbox/.test(otherClientSources)
  || (deliverySettingsSource.match(/type:\s*["']checkbox["']/g) ?? []).length !== 1
  || /role:\s*["']switch["']/u.test(deliverySettingsSource)
  || (deliverySyncSettingsSource.match(/type:\s*["']checkbox["']/g) ?? []).length !== 1
  || /role:\s*["']switch["']/u.test(deliverySyncSettingsSource)
  || /role:\s*["']switch|type:\s*["']checkbox/u.test(personaSettingsSource)
  || (offPeakSettingsSource.match(/type:\s*["']checkbox["']/g) ?? []).length !== 1
  || (offPeakSettingsSource.match(/role:\s*["']switch["']/g) ?? []).length !== 1
  || (groupBrainSettingsSource.match(/type:\s*["']checkbox["']/g) ?? []).length !== 1
  || (groupBrainSettingsSource.match(/role:\s*["']switch["']/g) ?? []).length !== 1
  || !personaSettingsSource.includes('<dsh_im_persona>')
  || (client.match(/role:\s*["']switch["']/g) ?? []).length !== 3
  || (client.match(/type:\s*["']checkbox["']/g) ?? []).length !== 6) {
  throw new Error('checkable inputs must be limited to context enhancement, Session sync, Delivery, off-peak, and the group brain toggles');
}
for (const marker of [
  'settings.group-brain.get',
  'settings.group-brain.set',
  'settings.group-brain.status',
  'settings.group-brain.consolidate',
  'settings.group-brain.wechat-personal.test',
  'settings.group-brain.wechat-personal.personas',
]) {
  if (!host.includes(marker) || !client.includes(marker)) {
    throw new Error(`group brain RPC endpoint missing from Host or Client bundle: ${marker}`);
  }
}
for (const marker of ['settings.off-peak.get', 'settings.off-peak.set', 'settings.off-peak.sync-holidays']) {
  if (!host.includes(marker) || !client.includes(marker)) {
    throw new Error(`off-peak RPC endpoint missing from Host or Client bundle: ${marker}`);
  }
}
for (const marker of ['bot.persona.get', 'bot.persona.set']) {
  if (!host.includes(marker) || !client.includes(marker)) {
    throw new Error(`persona RPC endpoint missing from Host or Client bundle: ${marker}`);
  }
}
if (!host.includes('<dsh_im_persona>') || !client.includes('<dsh_im_persona>')) {
  throw new Error('persona injection marker missing from Host or Client bundle');
}
for (const marker of ['bot.context-enhancement.set', '<dsh_im_source>', '<dsh_im_source_guidance>']) {
  if (!host.includes(marker) || !client.includes(marker)) {
    throw new Error(`context-enhancement marker missing from Host or Client bundle: ${marker}`);
  }
}
if (!client.includes('DSH-IM Persona') || /id\s*:\s*["']@xmanrui\/dsh-im["']/u.test(client)) {
  throw new Error('client bundle still carries upstream branding or loader id');
}
if (!client.includes('container-type: inline-size')
  || !client.includes('@container (max-width: 680px)')) {
  throw new Error('client bundle does not contain the narrow-panel bot QR layout');
}
for (const marker of ['/weixin', '/qq']) {
  if (!host.includes(marker)) {
    throw new Error(`host bundle does not contain the internal ${marker} RPC provider`);
  }
}
for (const marker of ['/session Session ID', 'bindWorkspaceSession', 'session-subagent-unsupported']) {
  if (!host.includes(marker)) {
    throw new Error(`host bundle does not contain the Session binding marker: ${marker}`);
  }
}
// The personal edition keeps every channel inside this package and never
// depends on the upstream dsh-im package or its sibling plugins.
// Attribution text in the description is allowed; import specifiers are not.
const SIBLING_PLUGIN = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']@xmanrui\/dsh-[^"']*["']/u;
if (SIBLING_PLUGIN.test(host)) {
  throw new Error('host bundle still imports a sibling channel plugin');
}
if (SIBLING_PLUGIN.test(hostSource + clientSources)) {
  throw new Error('source still imports a sibling channel plugin');
}
for (const section of dependencySections) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (/^@xmanrui\/dsh-/.test(name)) {
      throw new Error(`${name} must not be declared in ${section} of the personal edition`);
    }
  }
}
if (Object.keys(lock.packages ?? {}).some((path) => /node_modules\/@xmanrui\/dsh-/.test(path))) {
  throw new Error('package lock still installs an upstream @xmanrui/dsh-* package');
}
if (!patch.includes('name: dsh-im-persona')) {
  throw new Error('bundle patch must activate only dsh-im-persona');
}
// Personal edition: only the Weixin and QQ channel runtimes stay installed.
const directDependencies = {
  '@tencent-connect/qqbot-connector': '1.2.0',
  '@tencent-connect/qqbot-nodejs': '1.0.4',
  qrcode: '1.5.4',
  undici: '7.30.1',
};
for (const [name, version] of Object.entries(directDependencies)) {
  if (manifest.dependencies?.[name] !== version) {
    throw new Error(`${name} must be a pinned direct dependency at ${version}`);
  }
}
{
  // Whitelist, so a dependency left behind by a removed channel fails here
  // instead of shipping an unused SDK.
  const allowedRuntime = new Set(Object.keys(directDependencies).concat([]));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!allowedRuntime.has(name)) {
      throw new Error(`${name} is not an allowed runtime dependency of the personal edition`);
    }
  }
}
if (manifest.bin?.['dsh-im-persona'] !== 'bin/dsh-im-persona.mjs') {
  throw new Error('package manifest must publish the dsh-im-persona executable');
}
if (!/(?:from\s*|import\s*\()\s*["']undici["']/.test(host)) {
  throw new Error('host bundle must retain undici as an external runtime dependency');
}
if (process.platform !== 'win32' && (executable.mode & 0o111) === 0) {
  throw new Error('dsh-im CLI is not executable');
}
if (/private-bot-token|must-be-rolled-back|DEEPSEEK_API_KEY=/.test(client + host)) {
  throw new Error('built artifacts contain a test or environment secret marker');
}
const { createImHostPlugin } = await import(pathToFileURL(resolve(root, 'lib/index.js')).href);
let deliveryApi;
await createImHostPlugin().apply({
  provide(name, service) {
    if (name === 'dshIm') deliveryApi = service;
  },
  // Inspect the published service without starting channels or opening connections.
  inject() {},
});
if (typeof deliveryApi?.createTarget !== 'function') {
  throw new Error('host bundle must expose dshIm.createTarget; rebuild before publishing');
}

console.log('Verified dsh-im-persona package artifacts.');
