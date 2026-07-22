import type { ProviderManagedSubagentAdapter } from '../../core/providers/types';
import { TOOL_SUBAGENT } from '../../core/tools/toolNames';

export const opencodeSubagentAdapter: ProviderManagedSubagentAdapter = {
  protocol: 'managed-agent',
  isOutputTool() {
    return false;
  },
  isSpawnTool(name) {
    return name === TOOL_SUBAGENT;
  },
};
