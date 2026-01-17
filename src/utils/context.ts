/**
 * Claudian - Context Utilities
 *
 * Current note and context file formatting for prompts.
 */

const CURRENT_NOTE_PREFIX_REGEX = /^<current_note>\n[\s\S]*?<\/current_note>\n\n/;

/** Formats current note in XML format. */
export function formatCurrentNote(notePath: string): string {
  return `<current_note>\n${notePath}\n</current_note>`;
}

/** Prepends current note to a prompt. */
export function prependCurrentNote(prompt: string, notePath: string): string {
  return `${formatCurrentNote(notePath)}\n\n${prompt}`;
}

/** Strips current note prefix from a prompt. */
export function stripCurrentNotePrefix(prompt: string): string {
  return prompt.replace(CURRENT_NOTE_PREFIX_REGEX, '');
}

/**
 * Extracts the actual user query from an XML-wrapped prompt.
 * Used for comparing prompts during history deduplication.
 *
 * Priority:
 * 1. Content inside <query> tags (if present)
 * 2. Stripped prompt with all XML context removed
 */
export function extractUserQuery(prompt: string): string {
  if (!prompt) return '';

  // Try to extract content from <query> tags first
  const queryMatch = prompt.match(/<query>\n?([\s\S]*?)\n?<\/query>/);
  if (queryMatch) {
    return queryMatch[1].trim();
  }

  // Otherwise strip all XML context tags
  return prompt
    .replace(/<current_note>[\s\S]*?<\/current_note>\s*/g, '')
    .replace(/<editor_selection>[\s\S]*?<\/editor_selection>\s*/g, '')
    .replace(/<context_files>[\s\S]*?<\/context_files>\s*/g, '')
    .trim();
}

// ============================================
// Context Files (for InlineEditService)
// ============================================

/** Formats context files in XML format (used by inline edit). */
function formatContextFilesLine(files: string[]): string {
  return `<context_files>\n${files.join(', ')}\n</context_files>`;
}

/** Prepends context files to a prompt (used by inline edit). */
export function prependContextFiles(prompt: string, files: string[]): string {
  return `${formatContextFilesLine(files)}\n\n${prompt}`;
}
