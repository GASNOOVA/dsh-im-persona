import imageInput from '../../src/channels/shared/i18n-en/image-input.mjs';
import diagnostics from '../../src/channels/shared/i18n-en/diagnostics.mjs';
import weixinDiagnostics from '../../src/channels/weixin/connection-error.en.mjs';
import { PERSONA_I18N } from './persona-i18n.js';
import { RU } from './i18n-ru.js';
import * as React from 'react';

export const IM_LOCALE_NAMESPACE = 'dsh-im-persona';

// Sentences the settings UI composes itself: the dictionaries carry them as
// templates with `{name}` placeholders, looked up like any other key and filled in
// after translation (see localizeTemplate), so word order belongs to the target
// language instead of the Chinese sentence it was assembled from.
const COMPOSED = Object.freeze({
  '使用 Bot Token 接入 {channel} 机器人': 'Connect a {channel} bot with a Bot Token',
  '已接入的 {channel} 机器人': 'Connected {channel} bots',
  '正在读取 {channel} 机器人状态…': 'Loading {channel} bot status…',
  '无法读取 {channel} 机器人状态': 'Could not load {channel} bot status',
  '尚未接入 {channel} 机器人': 'No {channel} bot connected yet',
  '手动接入{channel}机器人': 'Connect {channel} bot manually',
  '{channel} 设置': '{channel} settings',
  '{name}机器人设置': '{name} bot settings',
  '{channel}机器人': '{channel} bot',
  '{channel} 服务返回了无法识别的响应': '{channel} service returned an unrecognized response',
  '{channel} 操作失败': '{channel} operation failed',
  '{channel}连接尚未就绪': '{channel} connection is not ready',
  '{channel} 服务没有返回有效的机器人列表': '{channel} service did not return a valid bot list',
  '{channel}操作失败，请稍后重试': '{channel} operation failed; try again later',
  '{channel} 设置页缺少 RPC 连接': 'The {channel} settings are missing an RPC connection',
  '{subject}运行正常': '{subject} is healthy',
  '{connected} / {configured} 在线': '{connected}/{configured} online',
  '已接入 {configured} 个机器人，其中 {connected} 个在线': '{connected} of {configured} bots online',
  '从 DeepSeek Harness 移除“{name}”？': 'Remove “{name}” from DeepSeek Harness?',
  '从 DeepSeek Harness 移除{name}': 'Remove {name} from DeepSeek Harness',
  '移除{name}': 'Remove {name}',
  '{bot}操作失败，请查看机器人状态。': '{bot} operation failed. Check the bot status.',
  '这会停止消息连接，并删除本机保存的 {credentials}、机器人配置及会话映射。{platform}中的机器人不会被自动删除。': 'This stops the message connection and removes the locally stored {credentials}, bot configuration, and session mappings. The bot in {platform} is not deleted.',
  '用于为{bot}补全权限与回调的一次性授权二维码': 'One-time QR code for completing permissions and the callback for {bot}',
  '用于为{bot}开通群消息权限的一次性授权二维码': 'One-time QR code for granting group-message permission to {bot}',
  '正在为「{bot}」补全权限与回调': 'Completing permissions and the callback for “{bot}”',
  '正在为「{bot}」开通群消息权限': 'Granting group-message permission to “{bot}”',
  '为{bot}补全权限与回调': 'Complete permissions and the callback for {bot}',
  '{bot}的权限与回调已补全。': 'Permissions and the callback completed for {bot}.',
  '{bot}已开通群消息权限，并启用“响应所有群消息”。': '{bot} now has group-message permission and “Respond to all group messages” is enabled.',
  '{bot}连接检查完成。': '{bot} connection check completed.',
  '{bot}已重新连接。': '{bot} reconnected.',
  '{bot}移除失败，请重试。': '{bot} could not be removed; try again.',
  '检查连接{name}': 'Check connection {name}',
  '重试连接{name}': 'Reconnect {name}',
  '二维码剩余 {remaining}': 'QR code expires in {remaining}',
  '连接检查失败：{error}（参考号：{reference}）': 'Connection check failed: {error} (reference: {reference})',
  '连接检查失败：{error}': 'Connection check failed: {error}',
  '操作失败：{error}': 'Operation failed: {error}',
  '状态刷新失败：{error}': 'Status refresh failed: {error}',
  '状态自动刷新失败：{error}': 'Automatic status refresh failed: {error}',
  '请输入 -1、0 或 1~{max} 之间的整数。': 'Enter -1, 0, or an integer from 1 to {max}.',
  '查看会话 {sessionId}': 'View session {sessionId}',
  '复制会话 ID {sessionId}': 'Copy session ID {sessionId}',
  '{count} 个会话': '{count} sessions',
  '事件 {seq}': 'Event {seq}',
  '读取失败：{error}': 'Could not read the session: {error}',
  '已显示 {shown} / {total} 条正文': 'Showing {shown} / {total} messages',
  '加载失败：{error}': 'Could not load channel sessions: {error}',
});

const EN = Object.freeze({
  ...COMPOSED,
  ...PERSONA_I18N.en,
  "私聊对象": "Private chat",
  "选择私聊对象": "Select a private chat",
  "仅支持已经建立会话的私聊，请先与机器人私聊后刷新。": "Only established private chats are supported. Message the bot privately, then refresh.",
  "选择 DS Bot 和私聊对象，直接使用 Bot 的会话。": "Choose a DS Bot and a private chat to use the Bot’s session.",
  "还没有可绑定的私聊。先给这个机器人发一条私聊消息，再点击刷新。": "No private chats yet. Send this bot a private message, then refresh.",

  "绑定 DS Bot": "Bind DS Bot",
  "正在检测 DS Bot…": "Checking DS Bot…",
  "选择 DS Bot": "Select DS Bot",
  "暂无可选 DS Bot": "No available DS Bots",
  "暂无可选私聊对象": "No available private chats",
  "已绑定的 DS Bot 和私聊对象不可重复选择，解除绑定后可重新选择。": "Bound DS Bots and private chats cannot be selected again. Unbind them to make them available.",
  "所选 DS Bot 或私聊对象已绑定，请刷新后重新选择。": "The selected DS Bot or private chat is already bound. Refresh and choose again.",
  "解除绑定": "Unbind",
  "已绑定": "Bound",
  "未安装 DS Bot，请先在 DSH 插件管理中安装 ds-bot，然后刷新。": "DS Bot is not installed. Install ds-bot in DSH plugin management, then refresh.",
  "DS Bot 尚未启用，请在 DSH 插件管理中启用后刷新。": "DS Bot is disabled. Enable it in DSH plugin management, then refresh.",
  "暂时无法读取 DS Bot，请检查插件是否正常运行后重试。": "Unable to read DS Bot. Check that the plugin is running, then retry.",
  "DS Bot 当前由其他 Host 管理，请在运行它的 Host 中绑定。": "DS Bot is managed by another Host. Bind it on that Host.",
  "绑定 DS Bot 仅支持当前 Host 的会话，请先检查机器人的 Harness 连接设置。": "DS Bot binding requires the current Host. Check the bot’s Harness connection settings.",
  "所选 DS Bot 已不存在，请刷新后重新选择。": "The selected DS Bot no longer exists. Refresh and select another.",
  "绑定设置保存失败，请刷新后重试。": "Could not save the binding. Refresh and retry.",
  "绑定已保存。": "Binding saved.",
  "已解除绑定，聊天记录保留。": "Binding removed. Chat history is preserved.",
  "还没有 DS Bot，请先在 DS Bot 中创建机器人后刷新。": "No bots yet. Create a bot in DS Bot, then refresh.",
  "DS Bot 暂不可用": "DS Bot unavailable",

  ...weixinDiagnostics,
  ...diagnostics,
  ...imageInput,
  '$locale': 'en',
  '侧边栏入口': 'Sidebar entry',
  '自动模式：未配置渠道时显示，配置至少一个渠道后隐藏。隐藏后仍可从插件详情或设置进入，不影响机器人后台运行。': 'Automatic: show before any channel is configured, then hide. Plugin details and Settings remain available; bots keep running in the background.',
  '自动隐藏': 'Auto-hide',
  '始终显示': 'Always show',
  '始终隐藏': 'Always hide',
  '正在读取侧边栏设置…': 'Loading sidebar settings…',
  '无法读取或保存侧边栏设置，请稍后重试。': 'Unable to read or save sidebar settings. Try again.',
  '侧边栏设置返回了无法识别的响应。': 'Unrecognized sidebar settings response.',
  '闲时启用': 'Off-peak only',
  '开启后仅在 DeepSeek API 非高峰时段响应消息；高峰时段静默丢弃入站消息，不调用 API，以节省费用。': 'When enabled, the bot only responds during DeepSeek API off-peak hours. During peak hours inbound messages are silently dropped without calling the API, saving cost.',
  '已开启，当前为非高峰时段，机器人正常响应。': 'Enabled · currently off-peak, the bot is responding normally.',
  '已开启，当前为高峰时段，入站消息将被静默丢弃，以节省 API 费用。': 'Enabled · currently peak hours, inbound messages are silently dropped to save API cost.',
  '已关闭，机器人始终响应消息。': 'Disabled · the bot always responds.',
  '非高峰时段：UTC 16:30–次日 00:30（北京时间 00:30–08:30）': 'Off-peak hours: 16:30–00:30 UTC (00:30–08:30 Beijing time).',
  '正在读取闲时启用设置…': 'Loading off-peak settings…',
  '无法读取或保存闲时启用设置，请稍后重试。': 'Could not read or save off-peak settings. Try again later.',
  '闲时启用设置返回了无法识别的响应。': 'Unrecognized off-peak settings response.',
  '已开启': 'Enabled',
  '已关闭': 'Disabled',
  '{channel} · {botId}：{groups} 个群，{pending} 个群待整理': '{channel} · {botId}: {groups} groups, {pending} awaiting consolidation',
  'daemon 正常，已登录 {user}（{connection}），可见会话 {threads} 个。': 'Daemon OK, signed in as {user} ({connection}), {threads} conversations visible.',
  '运行中：{user}（{groups} 个群）': 'Running: {user} ({groups} groups)',
  '未运行：{error}': 'Not running: {error}',
  '群聊大脑': 'Group brain',
  '正在读取群聊大脑设置…': 'Loading group brain settings…',
  '为小群提供主动接话、永久群记忆与成员画像。开启后，群内未 @ 机器人的消息也会进入记忆与话题判断；自动接话默认只对白名单群或已知 ≤5 人的小群生效。': 'Adds proactive replies, permanent group memory, and member profiles for small groups. When enabled, group messages that do not mention the bot also feed memory and topic detection; proactive replies default to allowlisted groups or known groups of up to 5 members.',
  '启用群聊大脑': 'Enable group brain',
  '关闭后不再记录群消息、不自动接话，也不会生成长期记忆。': 'When disabled, group messages are not recorded, the bot does not chime in, and no long-term memory is produced.',
  '自动接话': 'Proactive replies',
  '一段讨论结束后，根据话题自然接一句；不适合时会保持沉默。': 'After a discussion quiets down, add one natural reply on topic; stay silent when that would be inappropriate.',
  '自动接话白名单': 'Proactive reply allowlist',
  '每行一个群，格式：渠道:机器人ID:群ID:群名（群名可省略）。留空表示只对已知 ≤5 人的小群生效。': 'One group per line as channel:botId:chatId:groupName (group name optional). Leave empty to allow only known groups with up to 5 members.',
  '接话节奏': 'Reply pacing',
  '讨论静默': 'Discussion silence',
  '秒': 'seconds',
  '群内安静这么久后认为一段讨论结束。': 'Treat the discussion as finished after this much silence.',
  '最少消息数': 'Minimum messages',
  '一段讨论少于这么多条消息时不接话。': 'Do not chime in when a discussion has fewer messages than this.',
  '接话冷却': 'Reply cooldown',
  '分钟': 'minutes',
  '两次自动接话之间的最短间隔。': 'Shortest interval between two proactive replies.',
  '每小时上限': 'Hourly limit',
  '每小时最多主动发言次数。': 'Maximum proactive messages per hour.',
  '每日上限': 'Daily limit',
  '每天最多主动发言次数。': 'Maximum proactive messages per day.',
  '成员画像': 'Member profiles',
  '为群成员记录称呼、兴趣与说话风格；回复特定成员时参考其画像。': 'Record names, interests, and speaking style for group members; consult the profile when replying to a specific person.',
  '小群人数上限': 'Small-group member limit',
  '无法获知群成员数时，自动接话只对白名单群生效。': 'When the member count is unknown, proactive replies only apply to allowlisted groups.',
  '画像上限': 'Profile limit',
  '每个群最多保留的成员画像数量。': 'How many member profiles to keep per group.',
  '长期记忆': 'Long-term memory',
  '原始群消息永久保存在本机；按固定间隔压缩为长期记忆与成员画像，避免文件无限增长。': 'Raw group messages stay local permanently; at a fixed interval they are compressed into long-term memory and member profiles so files do not grow without bound.',
  '整理间隔': 'Consolidation interval',
  '每隔这么久把新增群消息整理进长期记忆。': 'How often new group messages are consolidated into long-term memory.',
  '记忆上限': 'Memory limit',
  '字符': 'characters',
  '长期记忆文件保留的最大字符数，超出时保留最近内容。': 'Maximum characters kept in the long-term memory file; the most recent content wins.',
  '保存群聊大脑设置': 'Save group brain settings',
  '设置已保存': 'Settings saved',
  '刷新运行状态': 'Refresh runtime status',
  '立即整理记忆': 'Consolidate memory now',
  '已刷新运行状态。': 'Runtime status refreshed.',
  '已触发记忆整理，稍后可刷新状态查看结果。': 'Memory consolidation started; refresh status later to see the result.',
  '群聊大脑设置返回了无法识别的响应。': 'Unrecognized group brain settings response.',
  '无法读取群聊大脑设置，请稍后重试。': 'Could not read group brain settings. Try again later.',
  '无法读取群聊大脑状态，请稍后重试。': 'Could not read group brain status. Try again later.',
  '无法保存群聊大脑设置，请稍后重试。': 'Could not save group brain settings. Try again later.',
  '无法触发记忆整理，请稍后重试。': 'Could not start memory consolidation. Try again later.',
  '暂无运行中的群聊大脑；机器人连接后会显示运行状态。': 'No group brain is running yet; status appears after a bot connects.',
  "群聊天记录": "Group chat history",
  "群聊天记录保留天数": "Group chat retention (days)",
  "过期的群消息和文件会自动清理。": "Expired group messages and files are removed automatically.",
  "保留天数": "Retention days",
  "天": "days",
  "正在读取群记录设置…": "Loading group history settings…",
  "保留天数必须为正整数。": "Retention days must be a positive integer.",
  "无法读取或保存群记录设置，请稍后重试。": "Unable to read or save group history settings. Try again.",
  "群记录设置返回了无法识别的响应。": "Unrecognized group history settings response.",
  '修改别名': 'Edit alias',
  '关闭修改别名': 'Close alias editor',
  '原名称': 'Original name',
  '别名': 'Alias',
  '恢复原名称': 'Restore original name',
  '例如：客服助手': 'e.g. Customer support',
  '仅更改显示名称，留空则显示原名称。': 'Only changes the display name. Leave blank to use the original name.',
  '别名保存失败，请重试。': 'Could not save the alias. Try again.',
  '别名不能包含换行或控制字符，且最多 80 个字符。': 'Use at most 80 characters without line breaks or control characters.',
  '先在 macOS 系统设置中授予 Messages 权限。': 'Grant Messages permissions in macOS System Settings first.',
  'IM机器人': 'IM bots',
  '打开 IM机器人': 'Open IM bots',
  'IM机器人设置': 'IM bot settings',
  'IM 面板加载失败': 'Could not load the IM panel',
  '更多机器人设置': 'More bot settings',
  '更多设置': 'More settings',
  '会话目录': 'Conversation directories',
  '会话目录隔离': 'Conversation directory isolation',
  '会话目录隔离已开启，工作区由对话自动分配。': 'Conversation directory isolation is enabled. Workspaces are assigned automatically.',
  '向左滚动设置页签': 'Scroll settings tabs left',
  '向右滚动设置页签': 'Scroll settings tabs right',
  '常用配置': 'Common settings',
  '机器人设置': 'Bot settings',
  '机器人设置页签': 'Bot settings tabs',
  '投递设置': 'Delivery settings',
  '群 ID': 'Group',
  '标题': 'Title',
  '（默认）': ' (default)',
  '自定义': 'Customize',
  '访问设置': 'Access settings',
  '查看访问权限说明': 'View access permission details',
  '允许所有用户': 'Allow all users',
  '仅白名单用户': 'Allowlisted users only',
  '默认命令权限': 'Default command permission',
  '命令权限': 'Command permission',
  '可以执行命令': 'Can run commands',
  '不可以执行命令': 'Cannot run commands',
  '白名单用户': 'Allowlisted users',
  '查看白名单说明': 'View allowlist details',
  '命令权限例外': 'Command permission exceptions',
  '当前没有白名单用户，保存后普通用户将无法使用机器人。': 'There are currently no allowlisted users. After saving, regular users will not be able to use the bot.',
  '新增用户': 'Add user',
  '尚未添加用户': 'No users added',
  '当前渠道不支持群聊': 'Group chat is not supported by this channel',
  '原所有者或扫码接入者始终可以访问并执行命令；以下设置仅约束其他用户。': 'The original owner or QR-code operator can always access the bot and run commands; the settings below apply only to other users.',
  '已由接入流程确认的所有者可以访问并执行命令，不受本页限制。未识别到所有者身份时，按本页访问设置执行。': 'Owners confirmed during connection setup can access the bot and run commands regardless of these settings. When no owner has been identified, these access settings apply.',
  '扫码获得的是私聊身份，群聊只有匹配已确认的所有者身份时才豁免；其他成员按群聊白名单设置执行。': 'QR setup identifies the owner for direct messages. In groups, only a matching confirmed owner identity is exempt; other members follow the group allowlist settings.',
  '此区域无需配置，保存私聊设置时会保留现有群聊策略。': 'No setup is needed here. Saving direct-message settings keeps the existing group policy.',
  '访问设置已保存。': 'Access settings saved.',
  '访问设置暂不可用。': 'Access settings are currently unavailable.',
  '访问设置保存失败，请稍后重试。': 'Could not save access settings. Try again later.',
  '服务没有返回已保存的访问策略，请刷新后重试。': 'The service did not return the saved access policy. Refresh and try again.',
  '访问策略尚未就绪，请返回机器人列表刷新后重试。': 'The access policy is not ready. Return to the bot list, refresh, and try again.',
  '当前渠道暂不支持访问设置。': 'Access settings are not supported by this channel yet.',
  '用户标识无效。': 'The user ID is invalid.',
  '用户标识必须是字符串。': 'The user ID must be a string.',
  '用户条目必须包含用户标识和命令权限。': 'Each user entry must include a user ID and command permission.',
  '命令权限必须是布尔值。': 'Command permission must be a boolean.',
  '访问模式只能是 open 或 allowlist。': 'Access mode must be open or allowlist.',
  '开放模式设置必须完整。': 'Open-mode settings must be complete.',
  '开放模式默认命令权限必须是布尔值。': 'The open-mode default command permission must be a boolean.',
  '开放模式命令权限覆盖用户必须是数组。': 'Open-mode command permission overrides must be an array.',
  '开放模式命令权限覆盖用户不能包含重复的用户标识。': 'Open-mode command permission overrides cannot contain duplicate user IDs.',
  '白名单模式设置必须完整。': 'Allowlist-mode settings must be complete.',
  '白名单模式用户必须是数组。': 'Allowlist-mode users must be an array.',
  '白名单模式用户不能包含重复的用户标识。': 'Allowlist-mode users cannot contain duplicate user IDs.',
  '访问场景设置必须同时包含模式、开放模式设置和白名单模式设置。': 'Each access context must include its mode, open-mode settings, and allowlist-mode settings.',
  '请同时提交完整的私聊和群聊访问设置。': 'Submit complete direct-message and group access settings together.',
  '填写微信用户 ID': 'Enter a WeChat user ID',
  '群成员 Open ID': 'Group member Open ID',
  '填写 member_openid': 'Enter member_openid',
  'QQ User Open ID': 'QQ User Open ID',
  '让 DeepSeek Harness 触手可及': 'Connecting DeepSeek Harness',
  '当前版本': 'Current version',
  'DSH-IM 更新': 'DSH-IM update',
  '检查更新': 'Check for updates',
  'DSH 版本兼容说明': 'DSH version compatibility',
  '重新检查': 'Check again',
  '刷新状态': 'Refresh status',
  '手工更新': 'Manual update',
  '手工更新命令': 'Manual update command',
  '复制命令': 'Copy command',
  '复制中…': 'Copying…',
  '已复制': 'Copied',
  '命令已复制。': 'Command copied.',
  '复制失败，请选中命令后按 Ctrl+C 或 ⌘C 复制。': 'Copy failed. Select the command and press Ctrl+C or ⌘C to copy it.',
  '自动更新失败可以使用命令更新：': 'If the automatic update fails, update with this command:',
  '尚未确认目标版本，此命令安装执行时 npm 的 latest 版本。': 'No target version has been confirmed. This command installs the npm latest version available when you run it.',
  '请在当前 Desktop 的内置终端执行，完成后手动重启。': 'Run this in the current Desktop’s built-in terminal, then restart manually.',
  '请在运行当前 Harness 的同一环境执行，保持 DSH_HOME 一致，完成后手动重启。': 'Run this in the same environment as the current Harness, with the same DSH_HOME, then restart manually.',
  '请等待当前操作结束，确认没有安装进程运行后再执行命令。': 'Wait for the current operation to finish and confirm no installer is running before using this command.',
  '源码或链接安装请按原安装方式更新，不提供覆盖源码的 npm 命令。': 'Update source or linked installations using their original method. No npm command is provided to overwrite the source.',
  '无法安全生成当前 profile 的命令，请在终端中手动确认 profile 后更新。': 'A safe command cannot be generated for this profile. Confirm the profile in your terminal before updating manually.',
  '更新至': 'Update to',
  '安装更新': 'Install update',
  '正在更新…': 'Updating…',
  '待手动重启': 'Restart needed',
  '运行版本': 'Running version',
  '已安装版本': 'Installed version',
  '目标 profile': 'Target profile',
  '目标版本': 'Target version',
  '最新版本': 'Latest version',
  '上次更新目标': 'Previous update target',
  '无法确认': 'Unknown',
  '发现新版本': 'Update available',
  '已是最新版本': 'Up to date',
  '当前版本无需更新': 'No newer version available',
  '已获取 npm 最新版本': 'Latest npm version retrieved',
  '检查 npm 最新版本，不会自动安装。': 'Check the latest npm version. Nothing is installed automatically.',
  '正在从 npm 检查最新版本…': 'Checking npm for the latest version…',
  '正在安装，请稍候…': 'Installing, please wait…',
  '正在校验安装结果…': 'Verifying the installation…',
  '已安装，待手动重启': 'Installed — manual restart needed',
  '更新已生效': 'Updated version is active',
  '更新失败': 'Update failed',
  '更新请求失败': 'Update request failed',
  '暂时无法安装更新': 'Update installation is unavailable',
  '仅更新 DSH-IM。安装完成后需手动重启后台；本功能不会自动重启或主动刷新页面。': 'Only DSH-IM will be updated. Restart the backend manually after installation. This feature does not automatically restart it or initiate a page refresh.',
  '当前是源码或链接安装，只能检查版本；请手动更新源码，或迁移到 npm 安装。': 'This is a source or linked installation. You can check versions, but must update the source manually or migrate to an npm installation.',
  '无法确认当前 profile，请在对应的 Harness 环境中手动更新。': 'The current profile could not be identified. Update manually in the corresponding Harness environment.',
  '当前运行环境不支持按钮安装，请手动更新插件。': 'This runtime cannot install through this button. Update the plugin manually.',
  '当前 npm 源配置与官方源不一致，请先检查 registry 配置。': 'The npm registry configuration differs from the official registry. Check your registry settings first.',
  '当前 Host 的 Node.js 版本不满足新版要求，请先更新运行环境。': 'The Host Node.js version does not meet the new version’s requirements. Update the runtime first.',
  '新版本已安装，请在方便时手动重启当前 Harness 或 Desktop。': 'The new version is installed. Manually restart this Harness or Desktop when convenient.',
  '上次安装结果无法确认，请先检查此 profile 的插件安装状态。': 'The previous installation result is uncertain. Check this profile’s plugin installation first.',
  '无法访问 npm 或请求超时，请稍后重新检查。': 'npm is unreachable or the request timed out. Check again later.',
  'npm 返回的版本信息无效，暂时无法更新。': 'npm returned invalid release information. Updating is unavailable.',
  '版本确认已过期，请重新检查后再安装。': 'The version confirmation expired. Check again before installing.',
  '插件安装状态已发生变化，请重新检查。': 'The plugin installation changed. Check again.',
  '此 profile 正在更新，请稍后查看状态。': 'This profile is already updating. Check its status shortly.',
  '安装失败，请检查当前安装状态后重试。': 'Installation failed. Check the current installation before retrying.',
  '安装结果校验失败，请手动检查插件版本。': 'Installation verification failed. Check the plugin version manually.',
  '无法安全保存更新状态，请先检查当前安装结果。': 'Update state could not be saved safely. Check the current installation result before retrying.',
  '上次更新已中断，请检查安装状态后重试。': 'The previous update was interrupted. Check the installation before retrying.',
  '更新服务已关闭，请手动重新打开设置页。': 'The update service has closed. Reopen settings manually.',
  '更新请求无效，请重新检查版本。': 'The update request is invalid. Check the version again.',
  '当前插件安装不完整或与 profile 不符，请手动检查安装配置。': 'The plugin installation is incomplete or does not match this profile. Check the installation configuration manually.',
  '无法确认当前 npm 源配置，暂时不能安装更新。': 'The npm registry configuration could not be verified. Installation is unavailable.',
  '安装超时，请先确认当前安装状态，再决定是否重试。': 'Installation timed out. Check the current installation before retrying.',
  '更新请求失败，请重试。': 'The update request failed. Try again.',
  '更新服务返回了无法识别的响应。': 'The update service returned an unrecognized response.',
  '当前 Host 不支持更新接口，请先手动更新插件并重启。': 'This Host does not support the update API. Update the plugin manually and restart first.',
  '关闭窗口不会取消安装。请勿同时在其他窗口管理此 profile 的插件。': 'Closing this window does not cancel installation. Do not manage this profile’s plugins in another window at the same time.',
  '页面版本与运行版本不同，请手动刷新页面；若仍不一致，请手动重启 Harness 或 Desktop。': 'The page and running versions differ. Refresh the page manually; if they still differ, manually restart Harness or Desktop.',
  '请在机器人空闲时安装；安装会修改当前 profile 的依赖，完成后需手动重启。': 'Install while bots are idle. This changes the current profile’s dependencies and requires a manual restart afterward.',
  '尚未配置': 'Not configured',
  '已配置': 'Configured',
  '凭据缺失': 'Credential missing',
  '测试中…': 'Testing…',
  '重新连接': 'Reconnect',
  '帮助与反馈 · 前往 GitHub': 'Help & feedback · Open GitHub',
  '请改用 localhost 重新打开': 'Reopen with localhost',
  '页面会在当前端口重新打开，机器人配置不会改变。': 'The page will reopen on the current port. Your bot configuration will not change.',
  '使用 localhost 重新打开': 'Reopen with localhost',
  '当前地址与浏览器的本机请求校验不兼容。请使用上方按钮改用 localhost 重新打开。': 'This address is incompatible with the browser’s local-request checks. Use the button above to reopen with localhost.',
  '微信': 'WeChat',
  '微信机器人': 'WeChat bot',
  'QQ机器人': 'QQ bot',
  '微信设置': 'WeChat settings',
  '个机器人，': 'bots,',
  '移除': 'Remove',
  '保存': 'Save',
  '扫码接入机器人': 'Scan QR code',
  '正在接入': 'Connecting',
  '手动接入': 'Manual setup',
  '收起凭据': 'Hide credentials',
  '展开该账号的设置': "Expand this account's settings",
  '收起该账号的设置': "Collapse this account's settings",
  '接入机器人': 'Connect bot',
  '在线': 'online',
  '运行正常': 'Connected',
  '正在连接': 'Connecting',
  '连接未就绪': 'Not connected',
  '离线': 'Offline',
  '消息通道': 'Message channel',
  '查看消息通道说明': 'View message channel details',
  '最近检查': 'Last checked',
  '最近一条消息处理失败': 'Latest message failed',
  '错误码': 'Code',
  '参考号': 'Reference',
  '当前工作区': 'Current workspace',
  '选择目录': 'Choose folder',
  '选择机器人工作区目录': 'Select bot workspace folder',
  '当前目录': 'Current folder',
  '主目录': 'Home',
  '直接输入路径': 'Enter a path directly',
  '支持 Windows 盘符、UNC 与 POSIX 绝对路径。': 'Supports Windows drives, UNC paths, and POSIX absolute paths.',
  '输入 Host 上的完整绝对路径': 'Enter a full absolute path on the Host',
  '前往': 'Go',
  '读取中…': 'Loading…',
  '正在准备目录选择器…': 'Preparing folder picker…',
  '正在读取目录…': 'Loading folders…',
  '这个目录中没有子文件夹。': 'This folder has no subfolders.',
  '此目录的子文件夹过多，仅显示前一部分。': 'This folder has too many subfolders; only the first group is shown.',
  '无法读取目录，请重试。': 'Could not load the folder. Try again.',
  '重试': 'Retry',
  '显示隐藏文件夹': 'Show hidden folders',
  '切换后会清除这个机器人的旧会话映射。': 'Switching clears this bot’s previous session mappings.',
  '切换中…': 'Switching…',
  '选择此目录': 'Select this folder',
  '工作区绝对路径': 'Absolute workspace path',
  '修改': 'Change',
  '上下文增强': 'Context enhancement',
  '未开启': 'Not enabled',
  '仅群聊': 'Groups only',
  '仅私聊': 'Direct only',
  '群聊和私聊': 'Groups and direct',
  '关闭弹窗': 'Close dialog',
  '查看上下文增强说明': 'View context enhancement details',
  '上下文增强范围': 'Context enhancement scope',
  '启用': 'Enabled',
  '（当前渠道不支持群聊）': '(This channel does not support group chats)',
  '来源字段': 'Source fields',
  '查看群聊来源字段说明': 'View group source field details',
  '查看私聊来源字段说明': 'View direct source field details',
  '渠道': 'Channel',
  '会话类型': 'Conversation type',
  '发送者标识': 'Sender ID',
  '发送者昵称': 'Sender name',
  '查看群聊发送者昵称字段说明': 'View group sender name field details',
  '查看私聊发送者昵称字段说明': 'View direct sender name field details',
  '该字段不是每个渠道都能提供。当前消息没有发送者昵称时，即使已选择该字段，<dsh_im_source> 中也会省略 senderName。': 'This field is not available on every channel. If the current message has no sender name, <dsh_im_source> omits senderName even when the field is selected.',
  '会话标题': 'Conversation title',
  '查看群聊会话标题字段说明': 'View group conversation title field details',
  '查看私聊会话标题字段说明': 'View direct conversation title field details',
  '会话标识': 'Chat ID',
  '查看群聊会话标识字段说明': 'View group chat ID field details',
  '查看私聊会话标识字段说明': 'View direct chat ID field details',
  '话题标识': 'Topic ID',
  '查看群聊话题标识字段说明': 'View group topic ID field details',
  '查看私聊话题标识字段说明': 'View direct topic ID field details',
  '机器人标识': 'Bot ID',
  '发送时间': 'Sent at',
  '查看群聊发送时间字段说明': 'View group sent-at field details',
  '查看私聊发送时间字段说明': 'View direct sent-at field details',
  '当前消息的发送时间，格式为 YYYY-MM-DD HH:mm:ss（本机时区）。优先使用平台给出的发送时间；平台未提供时，从微信消息 ID 中解析出发送时间；两者都不可用时，即使已选择该字段，<dsh_im_source> 中也会省略 sentAt。目前仅微信渠道提供；把本机时区写进增强提示词，模型判断先后顺序时更准确。': 'When the current message was sent, as YYYY-MM-DD HH:mm:ss in the local time zone. The platform send time is used when available; otherwise the send time is decoded from the WeChat message ID. If neither is available, <dsh_im_source> omits sentAt even when the field is selected. WeChat is the only channel that provides it today. Naming your time zone in the guidance makes ordering judgements more accurate.',
  '增强提示词': 'Guidance',
  '查看群聊增强提示词使用说明': 'View group guidance instructions',
  '查看私聊增强提示词使用说明': 'View direct guidance instructions',
  '使用说明': 'How to use',
  '生效规则': 'Behavior',
  '隐私提示': 'Privacy',
  '使用示例': 'Example',
  '填入示例': 'Use example',
  '清空': 'Clear',
  '选择在哪些会话中启用、提供哪些来源字段，以及如何使用这些信息。仅使用已有消息元数据，不查询平台 API。': 'Choose which conversations to enhance, which source fields to include, and how to use them. Only existing message metadata is used; no platform APIs are queried.',
  '增强提示词中请使用字段名（如 senderId、conversationType）引用这些信息。只发送当前会话中勾选且可用的字段，不会额外查询或补全。': 'Reference these values by field name (such as senderId or conversationType) in the guidance. Only fields selected and available in the current conversation are sent; no extra lookups are made.',
  '用于告诉模型如何使用当前群聊消息的 <dsh_im_source> 来源字段。只填写正文，插件会自动添加 <dsh_im_source_guidance> 成对标签。': 'Tell the model how to use <dsh_im_source> fields for the current group message. Enter only the body; the plugin adds paired <dsh_im_source_guidance> tags.',
  '用于告诉模型如何使用当前私聊消息的 <dsh_im_source> 来源字段。只填写正文，插件会自动添加 <dsh_im_source_guidance> 成对标签。': 'Tell the model how to use <dsh_im_source> fields for the current direct message. Enter only the body; the plugin adds paired <dsh_im_source_guidance> tags.',
  '仅在群聊开关开启时使用。清空并保存后不再附加群聊增强提示词；所选来源字段仍按当前场景设置发送。': 'Used only when group enhancement is enabled. Clear and save to omit group guidance; selected source fields still follow the group settings.',
  '仅在私聊开关开启时使用。清空并保存后不再附加私聊增强提示词；所选来源字段仍按当前场景设置发送。': 'Used only when direct enhancement is enabled. Clear and save to omit direct guidance; selected source fields still follow the direct settings.',
  '发送者标识可能包含平台用户 ID 或电话号码形式的标识。关闭开关不会删除已经写入会话历史的信息。': 'Sender IDs may contain platform user IDs or phone-number-like identifiers. Turning this off does not remove information already saved in conversation history.',
  '上下文增强保存失败，请重试。': 'Could not save context enhancement. Try again.',
  '请提交完整的上下文增强设置。': 'Submit the complete context enhancement settings.',
  '群聊和私聊开关必须是布尔值。': 'Group and direct switches must be booleans.',
  '来源字段只能选择已定义的字段。': 'Source fields must be chosen from the defined fields.',
  '保存中…': 'Saving…',
  '未设置': 'Not set',
  '工作区修改失败，请重试。': 'Could not update the workspace. Try again.',
  '请输入工作区绝对路径。': 'Enter an absolute workspace path.',
  '工作区必须是绝对路径。': 'The workspace must be an absolute path.',
  '工作区路径不存在。': 'The workspace path does not exist.',
  '工作区路径必须指向一个目录。': 'The workspace path must point to a directory.',
  '找不到要修改的机器人。': 'The bot could not be found.',
  'Agent Preset': 'Agent Preset',
  '查看 Agent Preset 说明': 'View Agent Preset help',
  '跟随 Host 默认': 'Follow the Host default',
  '（已不可用）': ' (unavailable)',
  '只影响新建会话；若当前聊天已有会话，先发送 /new，再发送普通消息生效。': 'This affects only new sessions. If the current chat already has a session, send /new, then send a regular message to apply it.',
  '当前 Agent Preset 已不可用，请选择其他 Preset 或跟随 Host 默认。': 'The current Agent Preset is unavailable. Choose another preset or follow the Host default.',
  'Agent Preset 修改失败，请重试。': 'Could not update the Agent Preset. Try again.',
  'Agent Preset 无效。': 'The Agent Preset is invalid.',
  'Agent Preset 不存在或不可用。': 'The Agent Preset does not exist or is unavailable.',
  '模型': 'Model',
  '模型与思考强度': 'Model and reasoning effort',
  '思考强度': 'Reasoning effort',
  '跟随模型默认': 'Model default',
  '先选择模型，再设置思考强度。': 'Select a model to configure its reasoning effort.',
  '该模型未提供可调节的思考强度。': 'This model does not provide adjustable reasoning effort.',
  '已保存的思考强度已不可用，请选择其他强度或恢复默认。': 'The saved reasoning effort is unavailable. Choose another effort or restore the default.',
  '使用模型或服务提供方的默认思考强度。': 'Use the default reasoning effort from the model or provider.',
  '当前模型不支持所选思考强度，请重新选择。': 'This model does not support the selected reasoning effort. Choose another effort.',
  '查看模型设置说明': 'View model setting help',
  '跟随默认模型': 'Follow the default model',
  '模型修改失败，请重试。': 'Could not update the model. Try again.',
  '无法读取所选模型的列表，模型设置未保存，请重试。': 'Could not load the selected model’s catalog. The model setting was not saved. Try again.',
  '模型无效。': 'The model is invalid.',
  '模型不存在或不可用。': 'The model does not exist or is unavailable.',
  '当前模型已不可用，请选择其他模型或跟随默认模型。': 'The current model is unavailable. Choose another model or follow the default.',
  '尚未检查': 'Not checked yet',
  '刚刚': 'Just now',
  '检查连接': 'Check connection',
  '检查中…': 'Checking…',
  '连接检查失败，请稍后重试。': 'Connection check failed. Try again later.',
  '测试消息已发送，请到对应机器人会话中确认。': 'Test message sent. Check the matching bot conversation.',
  '连接检查完成。机器人尚未收到可用于测试的私聊消息。': 'Connection check completed. The bot has not received a direct message it can use for testing.',
  '连接检查完成，但测试消息发送失败。': 'Connection check completed, but the test message could not be sent.',
  '微信连接检查完成，测试消息已发送。': 'WeChat connection check completed and the test message was sent.',
  '微信连接检查完成，但测试消息发送失败。': 'WeChat connection check completed, but the test message could not be sent.',
  '重试连接': 'Reconnect',
  '移除接入': 'Remove connection',
  '确认移除接入': 'Remove connection',
  '确认移除': 'Remove',
  '正在移除…': 'Removing…',
  '保留机器人': 'Keep bot',
  '保留账号': 'Keep account',
  '取消': 'Cancel',
  '关闭': 'Close',
  '立即重试': 'Retry now',
  '重新读取': 'Reload',
  '重新生成二维码': 'Generate a new QR code',
  '刷新二维码': 'Refresh QR code',
  '刷新中…': 'Refreshing…',
  '换一个二维码': 'Get another QR code',
  '继续连接': 'Continue connecting',
  '绑定并连接': 'Connect',
  '正在绑定…': 'Connecting…',
  '正在验证…': 'Verifying…',
  '操作失败，请稍后重试': 'The operation failed. Try again later.',
  '请稍后重试': 'Try again later.',
  '当前二维码有效时间': 'QR code expires in',
  '二维码有效时间': 'QR code expires in',
  '二维码已过期': 'QR code expired',
  '二维码已失效': 'QR code expired',
  '二维码图片正在生成…': 'Generating QR code…',
  '二维码正在自动刷新…': 'Refreshing QR code…',
  '二维码图片未就绪，请使用备用链接。': 'The QR code is not ready. Use the alternate link.',
  '正在刷新二维码': 'Refreshing QR code',
  '打开备用链接': 'Open alternate link',
  '生成二维码': 'Generate QR code',
  '生成微信二维码': 'Generate WeChat QR code',
  '生成 QQ 二维码': 'Generate QQ QR code',
  '正在生成二维码…': 'Generating QR code…',
  '正在准备微信二维码': 'Preparing WeChat QR code',
  '正在申请 QQ 二维码…': 'Requesting QQ QR code…',
  '机器人尚未连接': 'The bot is not connected yet',
  '长连接运行正常': 'Persistent connection is healthy',
  '长连接': 'Persistent connection',
  '应用标识已安全保存': 'App identifier stored securely',
  '已安全保存': 'Stored securely',
  '已接入的微信账号': 'Connected WeChat accounts',
  '已绑定的 QQ 机器人': 'Connected QQ bots',
  '使用手机微信扫描二维码': 'Scan with WeChat on your phone',
  '扫一次码，就能在微信里使用 Harness': 'Scan once to use Harness in WeChat',
  '打开手机微信并扫描左侧二维码': 'Open WeChat on your phone and scan the QR code',
  '在微信中确认连接该机器人': 'Confirm the bot connection in WeChat',
  '等待微信扫码': 'Waiting for WeChat scan',
  '需要配对码': 'Pairing code required',
  '输入手机微信显示的数字': 'Enter the number shown in WeChat',
  '微信配对码': 'WeChat pairing code',
  '已扫码，请在手机上确认': 'Scanned. Confirm on your phone',
  '配对码已提交，正在等待微信确认。': 'Pairing code submitted. Waiting for WeChat confirmation.',
  '这是微信附加的安全确认步骤。配对码只用于本次扫码轮询，不会写入配置或日志。': 'This is an additional WeChat confirmation step. The pairing code is used only for this connection and is never stored.',
  '正在保存凭据并验证 Harness 与微信长轮询。': 'Saving credentials and verifying the WeChat connection.',
  '微信已确认，正在启动消息连接': 'Confirmed in WeChat. Starting the message connection',
  '微信已授权，但无法读取现有登录凭据。请检查 DSH 凭据存储。': 'WeChat was authorized, but the existing login credential could not be read. Check the DSH credential store.',
  '微信已授权，但登录凭据无法写入 DSH 凭据存储。请检查凭据存储是否可写。': 'WeChat was authorized, but the login credential could not be written to the DSH credential store. Check that the store is writable.',
  '微信已授权，但账号配置无法写入本机。请检查 DSH_HOME 目录权限。': 'WeChat was authorized, but the account configuration could not be saved locally. Check the DSH_HOME directory permissions.',
  '微信已授权，但无法初始化账号状态或工作区。请检查 DSH_HOME 和工作区目录。': 'WeChat was authorized, but the account state or workspace could not be initialized. Check DSH_HOME and the workspace directory.',
  '微信已授权，但插件无法连接本机 Harness。请检查 dsh web 地址和端口。': 'WeChat was authorized, but the plugin could not connect to the local Harness. Check the dsh web address and port.',
  '微信已授权，但 Harness 健康检查超时。请确认 dsh web 未阻塞。': 'WeChat was authorized, but the Harness health check timed out. Confirm that dsh web is not blocked.',
  '微信已授权，但找不到 Harness 健康检查接口。请确认 Harness 与插件版本兼容。': 'WeChat was authorized, but the Harness health endpoint was not found. Confirm that Harness and the plugin are compatible.',
  '微信已授权，但 Harness 健康检查返回服务错误。请查看 dsh web 日志。': 'WeChat was authorized, but the Harness health check returned a service error. Check the dsh web logs.',
  '微信已授权，但 Harness 返回了无法识别的响应。请确认 Harness 与插件版本兼容。': 'WeChat was authorized, but Harness returned an unrecognized response. Confirm that Harness and the plugin are compatible.',
  '微信已授权，但 Harness 拒绝了健康检查请求。请查看 dsh web 日志。': 'WeChat was authorized, but Harness rejected the health-check request. Check the dsh web logs.',
  '微信已授权，但 Harness 健康检查发生未知错误。请查看 dsh web 日志。': 'WeChat was authorized, but the Harness health check failed unexpectedly. Check the dsh web logs.',
  '微信已授权，但消息连接初始化失败。请查看 dsh web 日志后重试。': 'WeChat was authorized, but the message connection could not be initialized. Check the dsh web logs and try again.',
  '微信已授权，但激活过程中发生未知错误。请查看 dsh web 日志。': 'WeChat was authorized, but an unknown error occurred during activation. Check the dsh web logs.',
  '微信已绑定，可以开始向已绑定的机器人发消息。': 'WeChat is connected and ready for messages.',
  '这个微信账号已经绑定并保持在线。': 'This WeChat account is connected and online.',
  '微信账号及本机凭据已移除。': 'The WeChat account and local credentials were removed.',
  '已取消微信绑定。': 'WeChat setup was cancelled.',
  '正在联系腾讯微信 iLink 服务。': 'Contacting the WeChat iLink service.',
  'iLink 长轮询': 'iLink long polling',
  '返回这里等待连接完成': 'Return here and wait for the connection to complete',
  'WebSocket 长连接': 'WebSocket persistent connection',
  '使用手机 QQ 扫码创建并绑定机器人': 'Scan with mobile QQ to create and connect a bot',
  '使用手机 QQ 完成机器人绑定': 'Complete bot setup with mobile QQ',
  '打开手机 QQ，扫描左侧二维码': 'Open mobile QQ and scan the QR code',
  '在腾讯授权页面确认创建或绑定机器人': 'Confirm bot creation or connection on the Tencent authorization page',
  '等待手机 QQ 扫码': 'Waiting for mobile QQ scan',
  'QQ 已授权，正在连接机器人': 'Authorized in QQ. Connecting the bot',
  '凭据正在写入本机，并启动 QQ WebSocket 消息连接。': 'Saving credentials locally and starting the QQ WebSocket connection.',
  '正在使用{name}…': 'Using {name}…',
  '访问模式': 'Access mode',
  '模式': 'Mode',
  '正在保存…': 'Saving…',
  '保存访问设置': 'Save access settings',
  '填写 QQ 开放平台 AppID': 'Enter the QQ Open Platform AppID',
  '填写 QQ 开放平台 AppSecret': 'Enter the QQ Open Platform AppSecret',
  '扫码接入微信机器人': 'Connect WeChat bot by QR code',
  '扫码接入 QQ 机器人': 'Connect QQ bot by QR code',
  '使用 AppID 和 AppSecret 绑定 QQ 机器人': 'Connect a QQ bot with AppID and AppSecret',
  '取消绑定': 'Cancel setup',
  '二维码由腾讯微信 iLink 服务签发。用手机微信扫描并确认后，账号凭据会直接写入 Harness Host，浏览器不会收到 bot_token。': 'The QR code is issued by Tencent WeChat iLink. After you scan and confirm, account credentials are written directly to the Harness Host and are never exposed to the browser.',
  '请在手机上核对并确认授权。部分账号会额外显示一个配对数字，页面会在需要时提示输入。': 'Review and confirm authorization on your phone. Some accounts may also require a pairing number.',
  '扫码由腾讯官方页面完成，不需要手动填写 AppID 或 AppSecret。扫码成功后，机器人会自动连接 DeepSeek Harness。': 'Scanning is completed on Tencent’s official page. No AppID or AppSecret is required, and the bot connects automatically.',
  '腾讯页面会创建或绑定一个 QQ 机器人，并把连接凭据安全交给本机 Harness Host。': 'Tencent will create or connect a QQ bot and securely deliver its credentials to the local Harness Host.',
  '从此 Harness 移除这个微信账号？': 'Remove this WeChat account from Harness?',
  '这会停止消息连接，并删除本机保存的 bot_token、账号配置和会话映射。其他微信账号不受影响。': 'This stops the message connection and removes the locally stored bot_token, account configuration, and session mappings. Other WeChat accounts are not affected.',
  '这会停止消息连接，并删除本机保存的应用凭据、机器人配置及会话映射。腾讯平台中的机器人不会被自动删除。': 'This stops the message connection and removes the locally stored app credentials, bot configuration, and session mappings. The bot on Tencent’s platform is not deleted.',
  '正在读取微信连接状态…': 'Loading WeChat connection status…',
  '二维码已过期\\n请重新生成': 'QR code expired\\nGenerate a new one',
  'QQ 服务没有返回扫码绑定进度': 'QQ did not return QR setup progress',
  'QQ 扫码服务没有返回有效的绑定任务': 'QQ did not return a valid setup attempt',
  'QQ WebSocket 长连接运行正常': 'QQ WebSocket connection is healthy',
  'QQ 连接未就绪，插件会自动重试。': 'The QQ connection is not ready; the plugin will retry automatically.',
  'QQ 连接未就绪，插件会自动重试': 'The QQ connection is not ready; the plugin will retry automatically',
  'QQ 连接当前离线': 'The QQ connection is currently offline',
  'QQ 服务没有返回有效的机器人列表': 'QQ did not return a valid bot list',
  '尚未绑定 QQ 机器人': 'No QQ bot connected yet',
  '用于绑定 QQ 机器人的一次性二维码': 'One-time QR code for connecting a QQ bot',
  '微信绑定没有完成': 'WeChat setup did not complete',
  '微信连接正常': 'WeChat connection is healthy',
  '微信连接未就绪': 'WeChat connection is not ready',
  '当前模型不支持图片，请用 /models 查看可用模型，再用 /model <序号> 切换后重发。': 'The current model does not support images. Use /models to list models, then /model <number> to switch and resend.',
  '图片超过宿主允许的大小，请压缩后重试。': 'The image exceeds the Host size limit. Compress it and try again.',
  '图片分辨率过高，请压缩后重试。': 'The image resolution is too high. Compress it and try again.',
  '图片内容无效或格式不受支持，请重新发送。': 'The image is invalid or unsupported. Send it again.',
  '未能读取图片内容，请重新发送。': 'The image could not be read. Send it again.',
  '图片格式与实际内容不一致，请重新发送。': 'The declared image format does not match its content. Send it again.',
  '一次发送的图片数量超过宿主限制，请减少后重试。': 'The message exceeds the Host image-count limit. Remove some images and try again.',
  '图片总大小超过宿主限制，请减少图片或压缩后重试。': 'The images exceed the Host total-size limit. Remove or compress some images and try again.',
  '图片下载地址发生了重定向，暂时无法读取。': 'The image download redirected and cannot be read.',
  '图片超过 5 MB，请压缩后重试。': 'The image exceeds 5 MB. Compress it and try again.',
  '一次发送的图片总大小过大，请减少图片数量或压缩后重试。': 'The images are too large in total. Remove or compress some images and try again.',
  '图片下载失败，请重新发送后再试。': 'The image download failed. Send it again.',
  '暂不支持该图片格式，请发送 JPEG、PNG、WebP 或 GIF 图片。': 'This image format is unsupported. Send a JPEG, PNG, WebP, or GIF image.',
  '消息处理失败，请稍后重试。': 'Message processing failed. Try again later.',
  '尚未绑定微信': 'No WeChat account connected yet',
  '用于把微信机器人绑定到 DeepSeek Harness 的一次性二维码': 'One-time QR code for connecting a WeChat bot to DeepSeek Harness',
  '保持本页打开，等待消息长轮询变为在线': 'Keep this page open until long polling is online',
  '微信二维码已生成，请使用手机微信扫描。': 'WeChat QR code generated. Scan it with WeChat on your phone.',
  '无法读取微信状态': 'Could not load WeChat status',
  '用户': 'User',
  '微信用户 ID': 'WeChat user ID',
  '填写接收消息的用户 ID': 'Enter the recipient user ID',
  '私聊': 'Direct message',
  '群聊': 'Group',
  '当前机器人': 'Current bot',
  '用户 ID': 'User ID',
  '单聊': 'Direct message',
  '用户 Open ID': 'User Open ID',
  '填写 user_openid': 'Enter the user_openid',
  '群 Open ID': 'Group Open ID',
  '填写 group_openid': 'Enter the group_openid',
  '会话': 'Conversation',
  '聊天': 'Chat',
  '话题': 'Topic',
  '请求失败，请稍后重试。': 'Request failed. Try again later.',
  '当前浏览器不支持自动复制，请手动选择复制。': 'Automatic copy is unavailable. Select and copy the value manually.',
  '目标保存失败，请检查后重试。': 'Could not save the target. Check it and try again.',
  '无法生成未占用的 Target ID，请重试。': 'Could not generate an unused Target ID. Try again.',
  '编辑投递目标': 'Edit delivery target',
  '新建投递目标': 'New delivery target',
  '已从会话自动填入目标信息；确认后再保存。': 'Target details were filled from the conversation. Review them before saving.',
  '请手动填写从对应平台取得的原生标识。': 'Enter the native identifier from the platform manually.',
  '例如 daily-report': 'For example, daily-report',
  '显示名称（可选）': 'Display name (optional)',
  '例如 每日汇报群': 'For example, Daily reports',
  '目标类型': 'Target type',
  '保存目标': 'Save target',
  '请先完成投递目标读取': 'Wait for delivery targets to finish loading',
  '从已聊过的会话选择': 'Choose from conversations',
  '已聊会话': 'Conversation',
  '从会话选择targetID': 'Select a targetID from conversations',
  '选择后会自动填写目标信息和调用别名，确认后再保存。': 'Selecting a conversation fills the target details and call alias. Review them before saving.',
  '正在刷新…': 'Refreshing…',
  '刷新': 'Refresh',
  '正在读取已聊会话…': 'Loading known conversations…',
  '无法读取已聊会话，请稍后重试。': 'Could not load known conversations. Try again later.',
  '还没有可选择的会话': 'No conversations to choose from',
  '先在对应平台与机器人聊一条消息，再刷新。': 'Send the bot a message on the platform, then refresh.',
  '已添加': 'Added',
  '手动填写（高级）': 'Enter manually (advanced)',
  '目标是细粒度设置：某个机器人一旦配置了目标（哪怕关闭会话同步），该机器人的投递就按目标走。如需使用「通用设置 → 投递」里的简单开关，请先删除该机器人的全部目标。': 'Targets are a fine-grained setting: once a bot has any target (even with session sync off), delivery for that bot follows the targets. To use the simple switches under General settings → Delivery, delete all of that bot’s targets first.',
  '测试消息已发送，请到目标会话确认。': 'Test message sent. Confirm it in the target conversation.',
  '测试发送失败，请稍后重试。': 'Test delivery failed. Try again later.',
  '已复制调用参数': 'Call parameters copied',
  '复制失败。': 'Copy failed.',
  '删除失败，请稍后重试。': 'Could not delete the target. Try again later.',
  '复制调用参数': 'Copy call parameters',
  '机器人离线时不可发送测试消息': 'Test delivery is unavailable while the bot is offline',
  '测试投递目标': 'Test delivery target',
  '测试': 'Test',
  '编辑': 'Edit',
  '删除': 'Delete',
  '删除 ': 'Delete ',
  '？使用这个 targetId 的外部调用将返回 unknown-target。': '? External calls using this targetId will return unknown-target.',
  '正在删除…': 'Deleting…',
  '确认删除': 'Delete target',
  '会话双向同步': 'Two-way Session sync',
  '自动跟随该私聊的当前会话': 'Automatically follow this direct message’s current Session',
  '等待该私聊建立新会话': 'Waiting for this direct message to establish a new Session',
  '关闭时不发送 DSH 会话消息': 'DSH Session messages are not sent while disabled',
  '仅支持已经聊过、已建立当前会话且使用当前 Host Harness 的私聊目标': 'Only a known direct message with a current Session on this Host Harness is supported',
  '会话同步仅支持已经聊过、已建立当前会话且使用当前 Host Harness 的私聊目标。': 'Session sync requires a known direct message with a current Session on this Host Harness.',
  '会话同步设置失败，请稍后重试。': 'Could not update Session sync. Try again later.',
  '修改接收位置会关闭会话双向同步。': 'Changing the destination disables two-way Session sync.',
  ' 会话同步设置也会一并删除。': ' Its Session sync setting will also be deleted.',
  '投递目标设置暂不可用。': 'Delivery target settings are unavailable.',
  '无法读取投递目标，请稍后重试。': 'Could not load delivery targets. Try again later.',
  '← 返回机器人列表': '← Back to bots',
  '使用文档': 'User guide',
  '打开主动投递使用文档': 'Open the proactive delivery guide',
  '当前渠道暂不支持投递目标。': 'Delivery targets are not supported for this channel.',
  '已复制 Bot ID': 'Bot ID copied',
  '复制': 'Copy',
  '投递目标': 'Delivery targets',
  '机器人当前离线；仍可配置目标，恢复连接后再测试。': 'The bot is offline. You can still configure targets and test them after reconnection.',
  '新建目标': 'New target',
  '正在读取投递目标…': 'Loading delivery targets…',
  '尚未配置投递目标': 'No delivery targets yet',
  '点击“新建目标”可从已聊过的会话选择，也可手动填写。': 'Select New target to choose a conversation or enter the details manually.',
  "通用": "General",
  "机器人通用设置": "General bot settings",
  "消息处理方式": "Message handling",
  "排队": "Queue",
  "插话": "Steer",
  "当前任务结束后处理新消息": "Process new messages after the current task",
  "将新消息补充到当前任务": "Add new messages to the current task",
  '通用设置': 'General settings',
  '通用设置分类': 'General settings categories',
  '附件': 'Attachments',
  'IM 设置导航': 'IM settings navigation',
  '附件保留时长 (小时)': 'Attachment retention (hours)',
  '查看附件保留时长说明': 'View attachment retention details',
  '永久保留，不会自动清理': 'Keep forever; nothing is removed automatically',
  '每 Turn 结束后立即清理': 'Cleaned up as soon as each turn ends',
  '小时后自动清理': 'hours until automatic cleanup',
  '设置保存失败，请稍后重试。': 'Could not save the setting. Try again later.',
  '已保存': 'Saved',
  '通用设置暂不可用。': 'General settings are unavailable.',
  '正在读取通用设置…': 'Loading general settings…',
  '无法读取通用设置，请稍后重试。': 'Could not load general settings. Try again later.',
  '通用设置返回了无法识别的响应。': 'General settings returned an unrecognized response.',
  '清理过期附件': 'Clean up expired attachments',
  '确认清理过期附件': 'Confirm expired attachment cleanup',
  '确认清理当前已过期的附件？': 'Clean up the attachments that are currently expired?',
  '确认清理': 'Confirm cleanup',
  '正在清理…': 'Cleaning up…',
  '连接检查完成。': 'Connection check finished.',
  '连接检查完成，测试消息已发送。': 'Connection check finished; the test message was sent.',
  '端口': 'Port',
  '会话绑定': 'Session binding',
  '保存绑定': 'Save binding',
  '重新生成': 'Regenerate',
  '配对码': 'Pairing code',
  ' 分钟': ' minutes',
  '投递': 'Delivery',
  '会话同步': 'Session sync',
  '只对已开启会话同步的目标生效：在 Web GUI 里输入的回合、定时提醒、子代理通知等“不是本聊天发起”的回合，其回答会转发到这些目标。消息语言同时影响机器人发送的命令菜单文本。': 'Applies to targets with Session sync turned on: answers of turns this chat did not start (Web GUI input, schedule reminders, subagent notices) are forwarded to those targets. The message language also changes the command menus the bot sends.',
  '查看会话同步说明': 'Show Session sync help',
  '插件消息语言': 'Plugin message language',
  '跟随 DSH 界面语言': 'Same as the DSH interface',
  '中文': '中文',
  'English': 'English',
  'Русский': 'Русский',
  '镜像 Web 中输入的消息': 'Mirror messages typed in the Web UI',
  '输入前缀图标': 'Input prefix icon',
  '投递模型回答': 'Deliver model answers',
  '回答前缀图标': 'Answer prefix icon',
  '最多 32 个字符；留空则不添加前缀。': 'Up to 32 characters; leave it empty for no prefix.',
  '保存投递设置': 'Save delivery settings',
  '正在读取投递设置…': 'Loading delivery settings…',
  '投递同步设置通道不可用。': 'The delivery sync settings channel is unavailable.',
  '会话同步设置返回了无法识别的响应。': 'The delivery settings returned an unrecognized response.',
  '无法读取或保存会话同步设置，请稍后重试。': 'Could not load or save the delivery settings. Try again later.',
  '无效的会话同步设置：开关必须是布尔值，图标是不超过 32 个字符的文本。': 'Invalid delivery settings: a switch must be a boolean and an icon is text of at most 32 characters.',
  '默认跟随 DSH 界面语言；可以单独固定机器人消息的语言。': 'Follows the DSH interface language by default; you can pin the language of the bot messages separately.',
  '语言设置暂不可用。': 'The language setting is unavailable.',
  '在 Web GUI 中发送的消息会作为一条带前缀的消息转发到本聊天的会话同步目标。': 'A message sent in the Web GUI is forwarded to the Session sync target of this chat, prefixed with the icon.',
  '其他回合（Web 输入、定时提醒、子代理通知等）的模型回答会发送到会话同步目标。': 'Model answers of other turns (Web input, schedule reminders, subagent notices and so on) are sent to the Session sync target.',
  '浏览器未允许访问剪贴板': 'The browser did not allow clipboard access',
  '宿主响应缺少 value.channels，请检查 dsh-im-persona host 是否已重载': 'The Host response is missing value.channels. Reload the dsh-im-persona Host and try again.',
  '宿主响应缺少 value.messages，请检查 dsh-im-persona host 是否已重载': 'The Host response is missing value.messages. Reload the dsh-im-persona Host and try again.',
  '宿主响应缺少 value.messages': 'The Host response is missing value.messages',
  '查看该会话的用户与助手正文': 'View the user and assistant messages in this session',
  '复制失败': 'Copy failed',
  '复制 ID': 'Copy ID',
  '通道 / 会话键': 'Channel / conversation key',
  'DSH 会话 ID': 'DSH session ID',
  '操作': 'Actions',
  '助手': 'Assistant',
  '本条消息过长，已截断。': 'This message was too long and has been truncated.',
  '会话内容': 'Session content',
  '只读显示用户与助手正文；系统提示、工具调用和内部推理不显示。': 'Read-only user and assistant messages. System prompts, tool calls, and internal reasoning are hidden.',
  '返回列表': 'Back to list',
  '加载更早消息': 'Load earlier messages',
  '加载中…': 'Loading…',
  '没有可显示的用户或助手正文。': 'No user or assistant messages to display.',
  '会话记录': 'Session history',
  '返回 IM机器人': 'Back to IM bots',
  '只读列出各 IM 通道当前绑定的 DSH 会话；点击会话 ID 查看正文，不会修改绑定。': 'Read-only list of DSH sessions bound to each IM channel. Select a session ID to view its messages; bindings are not changed.',
  '正在读取通道会话…': 'Loading channel sessions…',
  '尚未发现已绑定 DSH 会话的通道。': 'No channels with bound DSH sessions were found.',
  '请求失败': 'The request failed',
});

export const en = EN;
export const zh = Object.freeze(Object.fromEntries(
  Object.keys(EN).map((key) => [key, key === '$locale' ? 'zh' : key]),
));

// Russian, narrowed to the keys this UI asks for: the shared Host modules it is
// built from also carry strings no settings surface renders, and a namespace
// dictionary holding keys the English one does not know would let a mistyped
// Chinese key hide behind a lookup that happens to miss. The English text is the
// last resort for a key the narrowed dictionary somehow lost.
export const ru = Object.freeze(Object.fromEntries(
  Object.keys(EN).map((key) => [key, RU[key] ?? EN[key]]),
));

let translate = (key) => key;

export function setImTranslator(next) {
  translate = typeof next === 'function' ? next : (key) => key;
}

// The language these dictionaries are rendering in. Read through the `$locale`
// entry rather than a snapshot taken at load time, so a locale whose dictionary
// registers later is still reported correctly. Anything unrecognized means
// Chinese, the identity language.
export function imLocale() {
  const id = translate('$locale');
  return id === 'en' || id === 'ru' ? id : 'zh';
}

export function isEnglish() {
  return translate('$locale') === 'en';
}

export const IM_RUSSIAN_LANGUAGE = Object.freeze({ id: 'ru', label: 'Русский', fallback: 'en' });

/**
 * Register Russian with the DSH locale registry: the definition makes it
 * selectable and chains its lookups to English, and the dictionary goes in as
 * one single-locale entry because `ru` is a language pack rather than one of the
 * two built-in locales.
 *
 * The definition is skipped when the id is already occupied — another language
 * pack may have registered `ru` first, and an occupied id is a hard error there.
 * The dictionary is registered either way, so Russian strings still resolve.
 *
 * @param locale - the client `locale` service.
 * @returns an idempotent disposer for both registrations.
 */
export function installImRussianLocale(locale) {
  if (typeof locale?.register !== 'function') return () => {};
  const disposers = [];
  const defined = (locale.getLocale?.()?.locales ?? []).some(
    (entry) => entry?.id === IM_RUSSIAN_LANGUAGE.id,
  );
  if (!defined && typeof locale.addLanguage === 'function') {
    try {
      disposers.push(locale.addLanguage(IM_RUSSIAN_LANGUAGE));
    } catch (error) {
      // The id may have been taken between the check and this call; that pack
      // owns the definition now, and registering the dictionary is still safe.
      if (!/already registered/iu.test(String(error?.message ?? ''))) throw error;
    }
  }
  disposers.push(locale.register(IM_LOCALE_NAMESPACE, IM_RUSSIAN_LANGUAGE.id, ru));
  return () => {
    // Reverse order: the dictionary goes before the definition that chains to it.
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        // A registry that already dropped the entry must not block teardown.
      }
    }
  };
}

/**
 * Localise a channel name the way the settings UI writes it: "微信" becomes
 * "WeChat" in English and Russian alike, while a name that is already Latin
 * (for example a channel display name) is handed back unchanged.
 */
export function channelName(value) {
  return localizeText(value);
}

// A broken WeChat configuration: the prefix, a `{file}` template sentence and an
// optional counter sentence, each resolved in the active language.
function configHint(match) {
  return [
    localizeText(match[1].trim()),
    translate('请检查微信渠道数据目录中的 {file}，修复后重启 DSH；“重新读取”不会重新加载配置。').replace('{file}', match[2]),
    match[3] ? localizeText(match[3]) : '',
  ].filter(Boolean).join(' ');
}

// Sentences composed outside the settings UI — a bot status or an RPC error that the
// host, or an IM platform, has already assembled — arrive as one string with no key
// to look up, so they are recognised by the Chinese shape they are built from. The
// client's own sentences are not here: they are template keys in the dictionaries
// (see COMPOSED and localizeTemplate), which keeps this table to the text that really
// has no key. Every rule carries a rendering per locale; `en` and `ru` are both
// mandatory, because a rule with an English column only is exactly what left a
// Russian reader looking at Chinese. Chinese needs no column of its own.
const DYNAMIC_RULES = Object.freeze([
  {
    pattern: /^微信配置格式错误：(config\.json|workspaces\.json)。请查看诊断详情，修复后重启 DSH。$/,
    // Both dictionaries already hold this sentence as a `{file}` template, so the
    // rendering goes through the lookup rather than restating the text here.
    en: (match) => EN['微信配置格式错误：{file}。请查看诊断详情，修复后重启 DSH。'].replace('{file}', match[1]),
    ru: (match) => translate('微信配置格式错误：{file}。请查看诊断详情，修复后重启 DSH。').replace('{file}', match[1]),
  },
  {
    pattern: /^(.*?)请检查微信渠道数据目录中的 (config\.json|workspaces\.json)，修复后重启 DSH；“重新读取”不会重新加载配置。\s*(字段位置中的序号从 0 开始，按文件中的条目顺序计数，不包含真实账号标识。)?$/,
    en: (match) => configHint(match),
    ru: (match) => configHint(match),
  },
  {
    pattern: /^增强提示词不得超过 (\d+) 个字符。$/,
    en: (match) => `Guidance must not exceed ${match[1]} characters.`,
    ru: (match) => `Подсказка для контекста не должна превышать ${match[1]} символов.`,
  },
  {
    pattern: /^一次最多只能处理 (\d+) 张图片。$/,
    en: (match) => `A message can contain at most ${match[1]} images.`,
    ru: (match) => `В одном сообщении может быть не больше ${match[1]} изображений.`,
  },
  {
    pattern: /^图片下载失败（HTTP (.+)），请重新发送后再试。$/,
    en: (match) => `The image download failed (HTTP ${match[1]}). Send it again.`,
    ru: (match) => `Не удалось скачать изображение (HTTP ${match[1]}). Отправьте его заново.`,
  },
]);

// Chinese fragments that survive inside messages no rule above recognises. Each row
// carries the source fragment and its rendering per locale, so the last-resort path
// is a table too rather than an English-only swap list.
const DYNAMIC_PHRASES = Object.freeze([
  ['DeepSeek Harness', 'DeepSeek Harness', 'DeepSeek Harness'],
  ['微信', 'WeChat', 'WeChat'],
  ['机器人', 'bot', 'бот'],
  ['账号', 'account', 'аккаунт'],
  ['应用', 'app', 'приложение'],
  ['凭据', 'credentials', 'учётные данные'],
  ['服务返回了无法识别的响应', 'service returned an unrecognized response', 'сервис вернул нераспознанный ответ'],
  ['服务没有返回有效的机器人列表', 'service did not return a valid bot list', 'сервис не вернул список ботов'],
  ['操作失败，请稍后重试', 'operation failed; try again later', 'операция не удалась, попробуйте позже'],
  ['操作失败', 'operation failed', 'операция не удалась'],
  ['连接尚未就绪', 'connection is not ready', 'подключение ещё не готово'],
  ['没有接入完成', 'was not connected', 'подключить не удалось'],
  ['没有绑定完成', 'was not connected', 'подключить не удалось'],
  ['设置页缺少 RPC 连接', 'settings are missing an RPC connection', 'в настройках нет подключения RPC'],
  ['设置', 'settings', 'настройки'],
  ['连接检查完成', 'connection check completed', 'проверка подключения завершена'],
  ['仍未连接，插件会继续自动重试', 'is still offline; the plugin will keep retrying', 'всё ещё не подключён, плагин продолжит попытки'],
  ['已重新连接', 'reconnected', 'переподключено'],
  ['移除失败，请重试', 'could not be removed; try again', 'удалить не удалось, попробуйте снова'],
  ['已连接，可以开始聊天', 'is connected and ready to chat', 'подключён, можно начинать переписку'],
  ['已连接，可以开始发送消息', 'is connected and ready for messages', 'подключён и готов отправлять сообщения'],
  ['服务请求失败', 'service request failed', 'запрос к сервису не удался'],
  // Failure reasons the host embeds in a message: they arrive as a captured phrase
  // inside an already localised sentence, so they need a translation of their own.
  ['网络中断', 'network down', 'сеть недоступна'],
  ['请求超时', 'request timed out', 'истекло время ожидания'],
  ['超时', 'timed out', 'истекло время ожидания'],
  ['服务不可用', 'service unavailable', 'сервис недоступен'],
  ['连接被拒绝', 'connection refused', 'соединение отклонено'],
  ['未授权', 'unauthorized', 'нет авторизации'],
  ['响应格式错误', 'malformed response', 'неверный формат ответа'],
  ['连接遇到问题', 'connection encountered a problem', 'проблема с подключением'],
  ['正在读取', 'Loading ', 'Загружаем '],
  ['连接状态', 'connection status', 'состояние подключения'],
  ['二维码', 'QR code', 'QR-код'],
]);

// The rules and their renderings, exposed so a test can hold every pattern to the
// same per-locale contract instead of trusting the order of the chain below.
export const IM_DYNAMIC_RULES = DYNAMIC_RULES;
export const IM_DYNAMIC_PHRASES = DYNAMIC_PHRASES;

/**
 * Localise a sentence the UI composed at runtime, e.g. `已接入的 {channel} 机器人`.
 *
 * @param text - the composed sentence, in the language the patterns are written in.
 * @param locale - `'en'`, `'ru'` or `'zh'`; anything else is served English, and
 *   Chinese is the identity language, so its text travels untouched.
 * @returns the sentence in the requested locale, or `text` when nothing matches.
 */
export function translateDynamic(text, locale = imLocale()) {
  if (locale === 'zh') return text;
  const column = locale === 'ru' ? 'ru' : 'en';
  for (const rule of DYNAMIC_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    return (rule[column] ?? rule.en)(match);
  }
  const at = column === 'ru' ? 2 : 1;
  let output = text;
  for (const row of DYNAMIC_PHRASES) output = output.replaceAll(row[0], row[at]);
  return output;
}

const TEMPLATE_PLACEHOLDER = /\{(\w+)\}/gu;

/**
 * Localise a sentence the settings UI composes itself, from a template key both
 * dictionaries carry: `已接入的 {channel} 机器人`. The key is looked up like any other
 * string — so a Russian reader gets the Russian sentence — and the values are filled
 * in afterwards, which keeps the word order of the translation instead of the
 * Chinese one the sentence was assembled from. A key neither dictionary knows comes
 * back as the key with its placeholders still visible, the same identity the rest of
 * the module falls back to.
 *
 * @param key - the Chinese template, e.g. `尚未接入 {channel} 机器人`.
 * @param values - one value per placeholder; a missing one keeps its braces so the
 *   gap is visible instead of silently empty.
 */
export function localizeTemplate(key, values) {
  if (typeof key !== 'string') return key;
  const template = translate(key);
  if (values == null) return template;
  return template.replace(TEMPLATE_PLACEHOLDER, (placeholder, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  ));
}

export function localizeText(value) {
  if (typeof value !== 'string') return value;
  const exact = translate(value);
  if (exact !== value) return exact;
  // A whole-string lookup missing means the UI composed the sentence at runtime.
  // Chinese is the identity language, so `translateDynamic` hands the text back in
  // its own language there and renders it in the active locale everywhere else.
  return translateDynamic(value);
}

const LOCALIZED_PROPS = Object.freeze([
  'aria-label',
  'alt',
  'placeholder',
  'title',
]);

function localizeChild(child) {
  if (typeof child === 'string') return localizeText(child);
  if (Array.isArray(child)) return child.map(localizeChild);
  return child;
}

export function h(type, props, ...children) {
  let localizedProps = props;
  if (props) {
    for (const key of LOCALIZED_PROPS) {
      if (typeof props[key] === 'string') {
        localizedProps = localizedProps === props ? { ...props } : localizedProps;
        localizedProps[key] = localizeText(props[key]);
      }
    }
  }
  return React.createElement(type, localizedProps, ...children.map(localizeChild));
}
