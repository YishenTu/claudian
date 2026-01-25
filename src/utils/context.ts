/**
 * Claudian - Context Utilities
 *
 * Current note and context file formatting for prompts.
 */

// Matches <current_note> at the START of prompt (legacy format)
const CURRENT_NOTE_PREFIX_REGEX = /^<current_note>\n[\s\S]*?<\/current_note>\n\n/;
// Matches <current_note> at the END of prompt (current format)
const CURRENT_NOTE_SUFFIX_REGEX = /\n\n<current_note>\n[\s\S]*?<\/current_note>$/;

/** Formats current note in XML format. */
export function formatCurrentNote(notePath: string): string {
  return `<current_note>\n${notePath}\n</current_note>`;
}

/** Appends current note to a prompt. */
export function appendCurrentNote(prompt: string, notePath: string): string {
  return `${prompt}\n\n${formatCurrentNote(notePath)}`;
}

/**
 * Strips current note context from a prompt (both prefix and suffix formats).
 * Handles legacy (prefix) and current (suffix) formats.
 */
export function stripCurrentNotePrefix(prompt: string): string {
  // Try prefix format first (legacy)
  const strippedPrefix = prompt.replace(CURRENT_NOTE_PREFIX_REGEX, '');
  if (strippedPrefix !== prompt) {
    return strippedPrefix;
  }
  // Try suffix format (current)
  return prompt.replace(CURRENT_NOTE_SUFFIX_REGEX, '');
}

/**
 * Extracts the actual user query from an XML-wrapped prompt.
 * Used for comparing prompts during history deduplication.
 *
 * Handles two formats:
 * 1. Legacy: <query>user content</query> with context prepended
 * 2. Current: User content first, context XML appended after
 */
export function extractUserQuery(prompt: string): string {
  if (!prompt) return '';

  // Legacy format: content inside <query> tags
  const queryMatch = prompt.match(/<query>\n?([\s\S]*?)\n?<\/query>/);
  if (queryMatch) {
    return queryMatch[1].trim();
  }

  // Current format: user content before any XML context tags
  // Context tags are always appended with \n\n separator, so anchor to that
  const xmlContextPattern = /\n\n<(?:current_note|editor_selection|editor_cursor|context_files)[\s>]/;
  const xmlMatch = prompt.match(xmlContextPattern);
  if (xmlMatch && xmlMatch.index !== undefined && xmlMatch.index >= 0) {
    return prompt.substring(0, xmlMatch.index).trim();
  }

  // No XML context - return the whole prompt stripped of any remaining tags
  return prompt
    .replace(/<current_note>[\s\S]*?<\/current_note>\s*/g, '')
    .replace(/<editor_selection[\s\S]*?<\/editor_selection>\s*/g, '')
    .replace(/<editor_cursor[\s\S]*?<\/editor_cursor>\s*/g, '')
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

/** Appends context files to a prompt (used by inline edit). */
export function appendContextFiles(prompt: string, files: string[]): string {
  return `${prompt}\n\n${formatContextFilesLine(files)}`;
}
