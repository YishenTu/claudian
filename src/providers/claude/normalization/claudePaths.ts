import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import type { ToolCallInfo, ToolResultDetails } from '@/core/types';

/** Native absolute paths cross the provider boundary as host paths; relative paths keep their meaning. */
export function toClaudeHostPath(value: string, target?: ExecutionTarget): string {
  if (target?.method !== 'wsl' || !value.startsWith('/')) return value;
  const mapped = createExecutionPathMapper(target).toHostPath(value);
  if (!mapped) throw new Error('Unable to map Claude Code path to the host');
  return mapped;
}

const NATIVE_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'], Glob: ['path'], Grep: ['path'], LS: ['path'],
};

export function mapClaudeToolInputPaths(
  name: string, input: Record<string, unknown>, target?: ExecutionTarget,
): Record<string, unknown> {
  if (target?.method !== 'wsl') return input;
  const mapped = { ...input };
  for (const key of NATIVE_PATH_FIELDS[name] ?? []) {
    if (typeof mapped[key] === 'string') mapped[key] = toClaudeHostPath(mapped[key], target);
  }
  return mapped;
}

export function mapClaudeToolResultPaths(
  details: ToolResultDetails | undefined, target?: ExecutionTarget,
): ToolResultDetails | undefined {
  if (!details?.diff?.filePath || target?.method !== 'wsl') return details;
  return { ...details, diff: { ...details.diff, filePath: toClaudeHostPath(details.diff.filePath, target) } };
}

export function mapClaudeHistoryToolPaths(tool: ToolCallInfo, target?: ExecutionTarget): void {
  if (target?.method !== 'wsl') return;
  tool.input = mapClaudeToolInputPaths(tool.name, tool.input, target);
  if (tool.diffData) tool.diffData = { ...tool.diffData, filePath: toClaudeHostPath(tool.diffData.filePath, target) };
  for (const child of tool.subagent?.toolCalls ?? []) mapClaudeHistoryToolPaths(child, target);
}
