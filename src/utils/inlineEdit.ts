/**
 * Utilities for inline edit UI.
 * Kept dependency-free so tests can import directly.
 */

/**
 * Trims leading and trailing blank lines from insertion text.
 * Matches the behavior expected by cursor insertion preview.
 */
export function normalizeInsertionText(text: string): string {
  return text.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '');
}

/** Escapes angle brackets to prevent HTML injection in diff previews. */
export function escapeHtml(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

