/**
 * Claudian - Context Utilities
 *
 * Current note and context file formatting for prompts.
 */

// Matches <current_note> at the START of prompt (legacy format)
const CURRENT_NOTE_PREFIX_REGEX = /^<current_note>\n[\s\S]*?<\/current_note>\n\n/;
// Matches <current_note> at the END of prompt (current format)
const CURRENT_NOTE_SUFFIX_REGEX = /\n\n<current_note>\n[\s\S]*?<\/current_note>$/;

/**
 * Pattern to match XML context tags appended to prompts.
 * These tags are always preceded by \n\n separator.
 * Matches: current_note, editor_selection (with attributes), editor_cursor (with attributes), context_files, canvas_context, attached_files
 */
export const XML_CONTEXT_PATTERN = /\n\n<(?:current_note|editor_selection|editor_cursor|context_files|canvas_context|attached_files)[\s>]/;

export function formatCurrentNote(notePath: string): string {
  return `<current_note>\n${notePath}\n</current_note>`;
}

export function appendCurrentNote(prompt: string, notePath: string): string {
  return `${prompt}\n\n${formatCurrentNote(notePath)}`;
}

/**
 * Strips current note context from a prompt (both prefix and suffix formats).
 * Handles legacy (prefix) and current (suffix) formats.
 */
export function stripCurrentNoteContext(prompt: string): string {
  // Try prefix format first (legacy)
  const strippedPrefix = prompt.replace(CURRENT_NOTE_PREFIX_REGEX, '');
  if (strippedPrefix !== prompt) {
    return strippedPrefix;
  }
  // Try suffix format (current)
  return prompt.replace(CURRENT_NOTE_SUFFIX_REGEX, '');
}

/**
 * Extracts user content that appears before XML context tags.
 * Handles two formats:
 * 1. Legacy: content inside <query> tags
 * 2. Current: user content first, context XML appended after
 */
export function extractContentBeforeXmlContext(text: string): string | undefined {
  if (!text) return undefined;

  // Legacy format: content inside <query> tags
  const queryMatch = text.match(/<query>\n?([\s\S]*?)\n?<\/query>/);
  if (queryMatch) {
    return queryMatch[1].trim();
  }

  // Current format: user content before any XML context tags
  // Context tags are always appended with \n\n separator
  const xmlMatch = text.match(XML_CONTEXT_PATTERN);
  if (xmlMatch?.index !== undefined) {
    return text.substring(0, xmlMatch.index).trim();
  }

  return undefined;
}

/**
 * Extracts the actual user query from an XML-wrapped prompt.
 * Used for comparing prompts during history deduplication.
 *
 * Always returns a string - falls back to stripping all XML tags if no
 * structured context is found.
 */
export function extractUserQuery(prompt: string): string {
  if (!prompt) return '';

  // Try to extract content before XML context
  const extracted = extractContentBeforeXmlContext(prompt);
  if (extracted !== undefined) {
    return extracted;
  }

  // No XML context - return the whole prompt stripped of any remaining tags
  return prompt
    .replace(/<current_note>[\s\S]*?<\/current_note>\s*/g, '')
    .replace(/<editor_selection[\s\S]*?<\/editor_selection>\s*/g, '')
    .replace(/<editor_cursor[\s\S]*?<\/editor_cursor>\s*/g, '')
    .replace(/<context_files>[\s\S]*?<\/context_files>\s*/g, '')
    .replace(/<canvas_context>[\s\S]*?<\/canvas_context>\s*/g, '')
    .replace(/<attached_files>[\s\S]*?<\/attached_files>\s*/g, '')
    .trim();
}

function formatContextFilesLine(files: string[]): string {
  return `<context_files>\n${files.join(', ')}\n</context_files>`;
}

export function appendContextFiles(prompt: string, files: string[]): string {
  return `${prompt}\n\n${formatContextFilesLine(files)}`;
}

/**
 * Format attached files for inclusion in prompts.
 * Each file path is listed so Claude Code SDK can read them.
 */
export function formatAttachedFiles(filePaths: string[]): string {
  if (filePaths.length === 0) return '';

  const fileList = filePaths.map(p => `- ${p}`).join('\n');
  return `<attached_files>\n${fileList}\n</attached_files>`;
}

/**
 * Append attached files to a prompt.
 * These are files the user explicitly added to the conversation context.
 */
export function appendAttachedFiles(prompt: string, filePaths: string[]): string {
  if (filePaths.length === 0) return prompt;
  return `${prompt}\n\n${formatAttachedFiles(filePaths)}`;
}

/**
 * Format canvas context (selected nodes and their ancestors) for inclusion in prompts.
 * The context includes the conversation thread from ancestor nodes.
 */
export function formatCanvasContext(canvasContext: string): string {
  return `<canvas_context>\n${canvasContext}\n</canvas_context>`;
}

/**
 * Append canvas context to a prompt.
 * Canvas context includes selected nodes and their ancestor nodes,
 * representing a conversation thread within a canvas.
 */
export function appendCanvasContext(prompt: string, canvasContext: string): string {
  return `${prompt}\n\n${formatCanvasContext(canvasContext)}`;
}
