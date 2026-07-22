import type { ProviderManagedSubagentAdapter } from '../../core/providers/types';
import { TOOL_AGENT_OUTPUT, TOOL_SUBAGENT } from '../../core/tools/toolNames';

export const claudeSubagentAdapter: ProviderManagedSubagentAdapter = {
  protocol: 'managed-agent',
  isOutputTool(name) {
    return name === TOOL_AGENT_OUTPUT;
  },
  isSpawnTool(name) {
    return name === TOOL_SUBAGENT;
  },
};
