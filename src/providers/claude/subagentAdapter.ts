import type { ProviderManagedSubagentAdapter } from '../../core/providers/types';
import { TOOL_AGENT_OUTPUT } from '../../core/tools/toolNames';
import { isClaudeSubagentToolName } from './subagentToolNames';

export const claudeSubagentAdapter: ProviderManagedSubagentAdapter = {
  protocol: 'managed-agent',
  isOutputTool(name) {
    return name === TOOL_AGENT_OUTPUT;
  },
  isSpawnTool(name) {
    return isClaudeSubagentToolName(name);
  },
};
