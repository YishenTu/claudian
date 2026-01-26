/**
 * Diff-related type definitions.
 *
 * Types for structured patch data from the SDK and diff line representation.
 * Used by rendering (DiffRenderer), streaming (StreamController), and
 * session loading (sdkSession).
 */

export interface DiffLine {
  type: 'equal' | 'insert' | 'delete';
  text: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** A single hunk from the SDK's structuredPatch format. */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Shape of the SDK's toolUseResult object for Write/Edit tools. */
export interface SDKToolUseResult {
  structuredPatch?: StructuredPatchHunk[];
  filePath?: string;
  [key: string]: unknown;
}
