# Group history

DSH-IM can archive the QQ group messages it actually receives, including attachments. Mention the bot in that group to query the archive, summarize the discussion, or read an attached file.

> The personal edition keeps only the Weixin (weixin) and QQ (qq) channels. Group history applies to **QQ only**; the Weixin channel has no group chats.

## Scope and limits

- An archive belongs to the group, not to a bot, AI session or workspace. Bots with the same group identity inside one DSH data directory read the same archive; switching sessions or workspaces, or deleting a bot, does not delete it.
- Only messages actually delivered by the platform are stored. QQ archives are isolated per application, so two QQ applications do not automatically share the archive of the same physical group.
- Edits and recalls are not synchronized, and bot-to-bot messages are not archived. Whether a media attachment is readable depends on the platform event carrying a downloadable file.
- Only a limited window is kept (14 days by default; configurable in the group history settings). This is a local archive, not a complete platform backup.

## Connecting a QQ group

1. Add a QQ bot through the QR flow or with AppID + AppSecret, then invite it to the target group.
2. The group owner must use the authorization entry QQ offers for that bot to allow it to see the whole conversation. Whether that entry exists depends on the QQ application and client; "the bot is in the group" alone does not prove it is authorized.
3. Adjust the retention days and the switch in the bot card or group history settings. Archiving is off by default and only applies to messages received after it is enabled.

The application needs permission to receive ordinary group messages; actual delivery still depends on the application capability and the group authorization. See the [official Tencent SDK](https://github.com/tencent-connect/qqbot-nodejs). When QQ does not deliver ordinary group messages to the application, this plugin cannot backfill them through local settings.

## Querying

Mention the bot in the group and ask normally, for example:

- "Summarize today's chat"
- "Who mentioned the deployment earlier?"
- "Read the file Alice sent"

The bot queries the built-in group history tools against the recent messages and attachments; only received and archived content can be found. Images and files are served from the local copies, so external links and undelivered messages never appear.

## Storage and cleanup

The archive lives in a local data directory under the DSH home (separate from each bot's state) and is isolated per group. Lowering the retention days removes expired records during later writes or cleanup; deleting the DSH data directory deletes the archive as well.
