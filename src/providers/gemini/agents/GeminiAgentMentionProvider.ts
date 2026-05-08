import type { AgentMentionProvider } from '../../../core/providers/types';
import type { GeminiAgentStorage } from '../storage/GeminiAgentStorage';
import type { GeminiAgentDefinition } from '../types/agent';

export class GeminiAgentMentionProvider implements AgentMentionProvider {
  private agents: GeminiAgentDefinition[] = [];

  constructor(private storage: GeminiAgentStorage) {}

  async loadAgents(): Promise<void> {
    this.agents = await this.storage.loadAll();
  }

  searchAgents(query: string): Array<{
    id: string;
    name: string;
    description?: string;
    source: 'plugin' | 'vault' | 'global' | 'builtin';
  }> {
    const q = query.toLowerCase();
    return this.agents
      .filter((agent) => isMentionableSubagent(agent))
      .filter((agent) => (
        agent.name.toLowerCase().includes(q) ||
        agent.description.toLowerCase().includes(q)
      ))
      .map((agent) => ({
        id: agent.name,
        name: agent.name,
        description: agent.description,
        source: 'vault' as const,
      }));
  }
}

function isMentionableSubagent(agent: GeminiAgentDefinition): boolean {
  if (agent.hidden || agent.disable) {
    return false;
  }

  return agent.mode === 'subagent';
}
