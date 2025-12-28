/**
 * Claudian - Context File Utilities
 *
 * Context file formatting and manipulation for prompts.
 */

const CONTEXT_FILES_PREFIX_REGEX = /^<context_files>\n[\s\S]*?<\/context_files>\n\n/;

/** Formats context files in XML format. */
export function formatContextFilesLine(files: string[]): string {
  return `<context_files>\n${files.join(', ')}\n</context_files>`;
}

/** Prepends context files to a prompt. */
export function prependContextFiles(prompt: string, files: string[]): string {
  return `${formatContextFilesLine(files)}\n\n${prompt}`;
}

/** Strips context files prefix from a prompt. */
export function stripContextFilesPrefix(prompt: string): string {
  return prompt.replace(CONTEXT_FILES_PREFIX_REGEX, '');
}
