import type { ProviderManagedSubagentAdapter } from '../../core/providers/types';
import { TOOL_AGENT_OUTPUT } from '../../core/tools/toolNames';
import { isClaudeSubagentToolName } from './subagentToolNames';

export const claudeSubagentAdapter: ProviderManagedSubagentAdapter = {
  protocol: 'managed-agent',
  // Legacy history compatibility (2026-09-29, SDK 0.3.283): "the TaskOutput tool was removed",
  // so only transcripts recorded before the removal contain it.
  isOutputTool(name) {
    return name === TOOL_AGENT_OUTPUT;
  },
  isSpawnTool(name) {
    return isClaudeSubagentToolName(name);
  },
};
