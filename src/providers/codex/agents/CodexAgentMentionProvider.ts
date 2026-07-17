import type { AgentMentionProvider } from '../../../core/providers/types';
import type { CodexSubagentStorage } from '../storage/CodexSubagentStorage';
import type { CodexSubagentDefinition } from '../types/subagent';

export class CodexAgentMentionProvider implements AgentMentionProvider {
  private agents: CodexSubagentDefinition[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(private storage: CodexSubagentStorage) {}

  async loadAgents(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    const promise = this.storage.loadAll().then((agents) => {
      this.agents = agents;
      this.loaded = true;
    });
    this.loadPromise = promise;
    try {
      await promise;
    } finally {
      if (this.loadPromise === promise) {
        this.loadPromise = null;
      }
    }
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadAgents();
    }
  }

  isLoaded(): boolean {
    return this.loaded;
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
