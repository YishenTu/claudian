const CONVERSATION_DIRECTORY_TITLE_MAX_LENGTH = 80;

export function formatConversationDirectoryTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) return '';
  if (firstLine.length <= CONVERSATION_DIRECTORY_TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, CONVERSATION_DIRECTORY_TITLE_MAX_LENGTH - 3)}...`;
}
