import type { AgentMentionProvider } from '../../../core/providers/types';
import type { CodexSubagentStorage } from '../storage/CodexSubagentStorage';
import type { CodexSubagentDefinition } from '../types/subagent';

export class CodexAgentMentionProvider implements AgentMentionProvider {
  private agents: CodexSubagentDefinition[] = [];

  constructor(private storage: CodexSubagentStorage) {}

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
      .filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      )
      .map(a => ({
        id: a.name,
        name: a.name,
        description: a.description,
        source: 'vault' as const,
      }));
  }
}
