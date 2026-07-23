import type { AgentInfo } from '@qoder-ai/qoder-agent-sdk';

import type { AgentMentionProvider } from '../../../core/providers/types';

export class QoderAgentMentionProvider implements AgentMentionProvider {
  private agents: AgentInfo[] = [];

  setAgents(agents: readonly AgentInfo[]): void {
    this.agents = agents.map(agent => ({ ...agent }));
  }

  searchAgents(query: string): Array<{
    id: string;
    name: string;
    description?: string;
    source: 'plugin' | 'vault' | 'global' | 'builtin';
  }> {
    const normalized = query.trim().toLowerCase();
    return this.agents
      .filter((agent) => {
        if (!normalized) return true;
        return agent.name.toLowerCase().includes(normalized)
          || (agent.description ?? '').toLowerCase().includes(normalized);
      })
      .map(agent => ({
        id: agent.name,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        source: 'builtin' as const,
      }));
  }
}
