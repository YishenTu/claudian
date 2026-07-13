// Pure helper for the voice queued-input badge: turn a queued message's content
// into a short, glanceable snippet. Kept pure (no DOM) so it can be unit-tested
// and so the badge stays a thin renderer. Mirrors the ~40-char truncation used
// by InputController.getQueuedMessageDisplay(), but that method is private, so we
// derive our own snippet here rather than reaching into chat internals.

/** Max characters of queued text shown in the badge before ellipsis. */
export const QUEUED_SNIPPET_MAX_LEN = 40;

/**
 * Collapse a queued message's content to a single-line snippet, trimmed and
 * truncated with an ellipsis. Newlines/runs of whitespace collapse to a single
 * space so the badge stays one short line. Returns '' for empty/whitespace input.
 */
export function queuedInputSnippet(
  content: string | null | undefined,
  maxLen: number = QUEUED_SNIPPET_MAX_LEN,
): string {
  const normalized = (content ?? '').replace(/\s+/g, ' ').trim();
  if (normalized === '') {
    return '';
  }
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return normalized.slice(0, maxLen) + '…';
}
