import type ClaudianPlugin from '../../main';
import { HomeFileAdapter } from '../storage/HomeFileAdapter';
import type { ProviderCommandCatalog } from './commands/ProviderCommandCatalog';
import type {
  AgentMentionProvider,
  ProviderCliResolver,
  ProviderId,
  ProviderRuntimeCommandLoader,
  ProviderSettingsTabRenderer,
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from './types';

/**
 * Registry for provider-owned workspace/bootstrap services.
 *
 * Unlike `ProviderRegistry`, this boundary owns app-level provider services such
 * as command catalogs, mention providers, MCP/plugin/agent managers, and
 * provider-specific storage adaptors.
 */
export class ProviderWorkspaceRegistry {
  private static registrations: Partial<Record<ProviderId, ProviderWorkspaceRegistration>> = {};
  private static services: Partial<Record<ProviderId, ProviderWorkspaceServices>> = {};

  static register(
    providerId: ProviderId,
    registration: ProviderWorkspaceRegistration,
  ): void {
    this.registrations[providerId] = registration;
  }

  private static getWorkspaceRegistration(providerId: ProviderId): ProviderWorkspaceRegistration {
    const registration = this.registrations[providerId];
    if (!registration) {
      throw new Error(`Provider workspace "${providerId}" is not registered.`);
    }
    return registration;
  }

  static async initializeAll(plugin: ClaudianPlugin): Promise<void> {
    const providerIds = Object.keys(this.registrations);
    const storage = plugin.storage;
    const vaultAdapter = storage.getAdapter();
    const homeAdapter = new HomeFileAdapter();

    for (const providerId of providerIds) {
      this.services[providerId] = await this.getWorkspaceRegistration(providerId).initialize({
        plugin,
        storage,
        vaultAdapter,
        homeAdapter,
      });
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

  static getCliResolver(providerId: ProviderId): ProviderCliResolver | null {
    return this.getServices(providerId)?.cliResolver ?? null;
  }

  static getRuntimeCommandLoader(providerId: ProviderId): ProviderRuntimeCommandLoader | null {
    return this.getServices(providerId)?.runtimeCommandLoader ?? null;
  }

  static getTabWarmupPolicy(providerId: ProviderId): ProviderTabWarmupPolicy | null {
    return this.getServices(providerId)?.tabWarmupPolicy ?? null;
  }

  static getMcpServerManager(providerId: ProviderId) {
    return this.getServices(providerId)?.mcpServerManager ?? null;
  }

  static getSettingsTabRenderer(providerId: ProviderId): ProviderSettingsTabRenderer | null {
    return this.getServices(providerId)?.settingsTabRenderer ?? null;
  }
}
