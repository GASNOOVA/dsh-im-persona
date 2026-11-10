export function groupHistoryAttachments(message) {
  const attachments = [];
  for (const [type, sources] of [['image', message?.images], ['file', message?.files]]) {
    for (const [index, source] of (sources ?? []).entries()) {
      attachments.push({ ...source, key: `${type}:${index}`,
        name: source.name ?? source.fileName ?? `${type}-${index + 1}`,
        mediaType: source.mediaType ?? source.mimeType,
        load: source.loadStream ?? source.load,
      });
    }
  }
  return attachments;
}

/** Record received groups before the response gate, without requiring a mention or an AI session. */
export async function captureGroupHistory(store, message, entry, { logger = console } = {}) {
  if (!store || !entry || message?.kind !== 'group') return message;
  try {
    const context = await store.capture({ ...entry,
      senderId: entry.senderId ?? message.senderId,
      text: entry.text ?? message.content ?? '',
      attachments: entry.attachments ?? groupHistoryAttachments(message),
    });
    // A context is a live service reference, not a model-controlled group selector.
    if (context) message.groupHistory = context;
  } catch (error) {
    logger.warn?.('[dsh-im] unable to save group message:', error?.message ?? 'archive unavailable');
  }
  return message;
}
