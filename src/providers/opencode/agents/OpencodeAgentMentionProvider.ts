import type { AgentMentionProvider } from '../../../core/providers/types';
import type { OpencodeAgentStorage } from '../storage/OpencodeAgentStorage';
import type { OpencodeAgentDefinition } from '../types/agent';

export class OpencodeAgentMentionProvider implements AgentMentionProvider {
  private agents: OpencodeAgentDefinition[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(private storage: OpencodeAgentStorage) {}

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

function isMentionableSubagent(agent: OpencodeAgentDefinition): boolean {
  if (agent.hidden || agent.disable) {
    return false;
  }

  return agent.mode === 'subagent';
}
