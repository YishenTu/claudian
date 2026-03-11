/** Runtime-only extension for blocked user messages (hook denials). */
export interface BlockedUserMessage {
  type: 'user';
  _blocked: true;
  _blockReason: string;
}

export function isBlockedMessage(message: { type: string }): message is BlockedUserMessage {
  return (
    message.type === 'user' &&
    '_blocked' in message &&
    (message as Record<string, unknown>)._blocked === true &&
    '_blockReason' in message
  );
}
