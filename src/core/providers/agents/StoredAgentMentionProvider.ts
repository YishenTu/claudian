import type {
  AgentMentionProvider,
  AgentMentionSource,
} from '../types';

export interface StoredAgentMentionDefinition {
  name: string;
  description?: string;
}

export interface StoredAgentMentionLoader<TAgent extends StoredAgentMentionDefinition> {
  loadAll(): Promise<TAgent[]>;
}

export interface StoredAgentMentionProviderOptions<TAgent extends StoredAgentMentionDefinition> {
  isMentionable?: (agent: TAgent) => boolean;
  source: AgentMentionSource;
}

export class StoredAgentMentionProvider<TAgent extends StoredAgentMentionDefinition>
implements AgentMentionProvider {
  private agents: TAgent[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(
    private readonly loader: StoredAgentMentionLoader<TAgent>,
    private readonly options: StoredAgentMentionProviderOptions<TAgent>,
  ) {}

  async loadAgents(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const promise = this.loader.loadAll().then((agents) => {
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
    source: AgentMentionSource;
  }> {
    const normalizedQuery = query.toLowerCase();
    return this.agents
      .filter(agent => this.options.isMentionable?.(agent) ?? true)
      .filter(agent => (
        agent.name.toLowerCase().includes(normalizedQuery)
        || (agent.description ?? '').toLowerCase().includes(normalizedQuery)
      ))
      .map(agent => ({
        id: agent.name,
        name: agent.name,
        description: agent.description,
        source: this.options.source,
      }));
  }
}
