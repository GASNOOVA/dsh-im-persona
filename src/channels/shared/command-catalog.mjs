/**
 * The session-navigation help lines every remaining channel that handles them
 * should list, without the file-export form of /tail (only file-capable
 * channels document that). The personal edition keeps two native bridges
 * (Weixin, QQ); the former generic text-channel catalog and its native-menu
 * support were removed with Telegram, Slack, Discord, WhatsApp and Matrix.
 */
export const SESSION_NAV_HELP_LINES = Object.freeze([
  '/ls 或 /list  列出本聊天使用过的会话（● 当前，←/→ 可前后切换，✕ 已失效；列表按聊天隔离）',
  '/go 会话编号  切换到该会话（编号见 /ls）',
  '/prev  回到上一个会话',
  '/next  前进到下一个会话',
  '/drop 会话编号  从本聊天会话列表移除该条记录（不删除 Harness 会话）',
  '/title  查看当前会话标题',
  '/title 新标题  重命名当前会话',
  '/title 会话编号 新标题  重命名指定会话',
  '/fork [标题]  从当前会话分支一个新会话（默认沿用父会话标题加“ (fork)”）',
  '/reset  重置当前会话上下文（保留会话编号，旧会话可 /session 找回）',
  '/tail 或 /peek [编号] [条数]  预览最近消息（默认 5 条，仅提问与回答）',
]);
