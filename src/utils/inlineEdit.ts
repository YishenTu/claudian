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

/** Escapes HTML special characters to prevent injection in rendered content. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

