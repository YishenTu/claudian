import { diffFromReplacements } from '@/core/tools/toolDiff';

import { normalizeToolResultDetails } from '../../core/tools/toolResultDetails';
import type { ToolResultDetails } from '../../core/types';

/**
 * Decodes the first ACP `diff` content entry. A diff without `oldText` describes a new file;
 * consumers then derive its presentation from the tool input.
 */
export function extractACPDiffResultDetails(content: unknown): ToolResultDetails | undefined {
  if (!Array.isArray(content)) return undefined;

  for (const entry of content) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const diff = entry as Record<string, unknown>;
    if (
      diff.type !== 'diff'
      || typeof diff.path !== 'string'
      || !diff.path.trim()
      || typeof diff.newText !== 'string'
    ) {
      continue;
    }

    const resultDiff = typeof diff.oldText === 'string'
      ? diffFromReplacements([{ oldText: diff.oldText, newText: diff.newText }], diff.path)
      : undefined;
    return resultDiff ? normalizeToolResultDetails({ diff: resultDiff }) : undefined;
  }

  return undefined;
}
