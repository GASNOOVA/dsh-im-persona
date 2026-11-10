# Access modes

Each bot has its own access-mode control on its bot card; in the personal edition only the Weixin and QQ channels are available.

**Weixin** bots use a private-chat allowlist: only the owner and the users listed in that bot's allowlist are admitted, and group messages are not supported. Enter one user ID per line. An empty allowlist rejects every inbound message for that bot.

**QQ** bots use a two-scope policy: direct chats follow the owner Open ID (`*` opens them to everyone), while group chats accept every member who can mention the bot in an admitted group. The allowlist is kept when a switch changes, and rejected messages are ignored silently.
