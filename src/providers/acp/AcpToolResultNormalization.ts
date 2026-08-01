import type { SDKToolUseResult } from '../../core/types/diff';

export function extractAcpDiffToolUseResult(content: unknown): SDKToolUseResult | undefined {
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

    return {
      filePath: diff.path,
      newText: diff.newText,
      ...(typeof diff.oldText === 'string' ? { oldText: diff.oldText } : {}),
    };
  }

  return undefined;
}
