import type ClaudianPlugin from '../../main';
import { PROVIDER_WORKSPACE_REGISTRATIONS } from '../../providers';
import type { ProviderCommandCatalog } from './commands/ProviderCommandCatalog';
import type {
  AgentMentionProvider,
  ProviderId,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from './types';

function getWorkspaceRegistration(providerId: ProviderId): ProviderWorkspaceRegistration {
  const registration = PROVIDER_WORKSPACE_REGISTRATIONS[providerId];
  if (!registration) {
    throw new Error(`Provider workspace "${providerId}" is not registered.`);
  }
  return registration;
}

/**
 * Registry for provider-owned workspace/bootstrap services.
 *
 * Unlike `ProviderRegistry`, this boundary owns app-level provider services such
 * as command catalogs, mention providers, MCP/plugin/agent managers, and
 * provider-specific storage adaptors.
 */
export class ProviderWorkspaceRegistry {
  private static services: Partial<Record<ProviderId, ProviderWorkspaceServices>> = {};

  static async initializeAll(plugin: ClaudianPlugin): Promise<void> {
    const providerIds = Object.keys(PROVIDER_WORKSPACE_REGISTRATIONS) as ProviderId[];

    for (const providerId of providerIds) {
      this.services[providerId] = await getWorkspaceRegistration(providerId).initialize({ plugin });
    }
  }

  static setServices(
    providerId: ProviderId,
    services: ProviderWorkspaceServices | undefined,
  ): void {
    if (services) {
      this.services[providerId] = services;
    } else {
      delete this.services[providerId];
    }
  }

  static clear(): void {
    this.services = {};
  }

  static getServices(
    providerId: ProviderId,
  ): ProviderWorkspaceServices | null {
    return this.services[providerId] ?? null;
  }

  static requireServices(
    providerId: ProviderId,
  ): ProviderWorkspaceServices {
    const services = this.getServices(providerId);
    if (!services) {
      throw new Error(`Provider workspace "${providerId}" is not initialized.`);
    }
    return services;
  }

  static getCommandCatalog(providerId: ProviderId): ProviderCommandCatalog | null {
    return this.getServices(providerId)?.commandCatalog ?? null;
  }

  static getAgentMentionProvider(providerId: ProviderId): AgentMentionProvider | null {
    return this.getServices(providerId)?.agentMentionProvider ?? null;
  }

  static async refreshAgentMentions(providerId: ProviderId): Promise<void> {
    await this.getServices(providerId)?.refreshAgentMentions?.();
  }
}
