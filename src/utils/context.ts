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
