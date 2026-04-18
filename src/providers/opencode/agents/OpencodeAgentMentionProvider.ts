import type { AgentMentionProvider } from '../../../core/providers/types';

export interface OpencodeSubagentDefinition {
  name: string;
  description: string;
  source: 'plugin' | 'vault' | 'global' | 'builtin';
}

export class OpencodeAgentMentionProvider implements AgentMentionProvider {
  private agents: OpencodeSubagentDefinition[] = [
    { name: 'general', description: 'General coding assistant', source: 'builtin' },
    { name: 'architect', description: 'System design and architecture', source: 'builtin' },
    { name: 'code', description: 'Code implementation focused', source: 'builtin' },
    { name: 'review', description: 'Code review specialist', source: 'builtin' },
    { name: 'debug', description: 'Debugging specialist', source: 'builtin' },
  ];

  async loadAgents(): Promise<void> {
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
        source: a.source as 'builtin',
      }));
  }
}
