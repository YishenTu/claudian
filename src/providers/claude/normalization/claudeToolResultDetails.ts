import { diffFromStructuredPatch } from '@/core/tools/toolDiff';

import { extractResolvedAnswers } from '../../../core/tools/toolInput';
import { normalizeToolResultDetails } from '../../../core/tools/toolResultDetails';
import type { StructuredPatchHunk, ToolResultDetails } from '../../../core/types';

/**
 * Decodes a native `tool_use_result` (live) or transcript `toolUseResult` (history) into the
 * neutral result fields: Write/Edit `structuredPatch` with its `filePath`, and AskUserQuestion
 * `answers`. Task/subagent fields stay native for the task-result interpreter.
 */
export function normalizeClaudeToolResultDetails(toolUseResult: unknown): ToolResultDetails | undefined {
  if (!isRecord(toolUseResult)) return undefined;
  const hunks = Array.isArray(toolUseResult.structuredPatch)
    ? toolUseResult.structuredPatch as StructuredPatchHunk[]
    : [];
  const filePath = typeof toolUseResult.filePath === 'string' && toolUseResult.filePath
    ? toolUseResult.filePath
    : undefined;
  const diff = diffFromStructuredPatch(hunks, filePath);
  const resolvedAnswers = extractResolvedAnswers(toolUseResult);
  return normalizeToolResultDetails({
    ...(diff ? { diff } : {}),
    ...(resolvedAnswers ? { resolvedAnswers } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
