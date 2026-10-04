import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from '@/core/providers/types';

interface AgentSkillResourceConsumer {
  invalidateProviderResources(providerIds: ProviderId[], generation: number): void;
}

/**
 * Publishes Vault skill changes to every skill-consuming provider. The new
 * generation reaches open chat views synchronously; initialized provider
 * workspaces refresh afterward, and lazy ones are never initialized for it.
 */
export class AgentSkillResources {
  private generation = 0;

  constructor(private readonly getConsumers: () => readonly AgentSkillResourceConsumer[]) {}

  getGeneration(): number {
    return this.generation;
  }

  async notifyChanged(): Promise<void> {
    const providerIds = ProviderWorkspaceRegistry.getAgentSkillProviderIds();
    const generation = ++this.generation;

    for (const consumer of this.getConsumers()) {
      consumer.invalidateProviderResources(providerIds, generation);
    }

    await Promise.all(providerIds.map(async providerId => {
      await ProviderWorkspaceRegistry.getIfInitialized(providerId)?.onAgentSkillsChanged?.();
    }));
  }
}
