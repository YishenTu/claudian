const CONVERSATION_DIRECTORY_TITLE_MAX_LENGTH = 80;

export interface ConversationDirectoryEntry {
  readonly title: string;
  /** Resolves the prompt on selection, rendering its earlier transcript window if necessary. */
  readonly reveal: () => HTMLElement | null;
}

/** Reads the titles published on rendered prompts, including new messages and edited previews. */
export function getRenderedConversationDirectory(messagesEl: HTMLElement): ConversationDirectoryEntry[] {
  return Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message-user, [data-role="user"]'))
    .map(el => ({
      reveal: () => el,
      title: (el.getAttribute('data-toc-title') ?? '').trim()
        || formatConversationDirectoryTitle(el.querySelector<HTMLElement>('.claudian-message-content')?.textContent ?? el.textContent ?? ''),
    }))
    .filter(entry => entry.title.length > 0);
}

export function formatConversationDirectoryTitle(text: string): string {
  const start = text.search(/\S/);
  if (start === -1) return '';
  const end = text.indexOf('\n', start);
  const firstLine = text.slice(start, end === -1 ? text.length : end).trimEnd();
  if (firstLine.length <= CONVERSATION_DIRECTORY_TITLE_MAX_LENGTH) return firstLine;
  const limit = CONVERSATION_DIRECTORY_TITLE_MAX_LENGTH - 3;
  // Back off one unit when the cut would split a surrogate pair.
  const splitsPair = firstLine.charCodeAt(limit - 1) >= 0xd800 && firstLine.charCodeAt(limit - 1) <= 0xdbff
    && firstLine.charCodeAt(limit) >= 0xdc00 && firstLine.charCodeAt(limit) <= 0xdfff;
  return `${firstLine.slice(0, splitsPair ? limit - 1 : limit)}...`;
}
