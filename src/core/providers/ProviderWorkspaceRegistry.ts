import { StartupProfiler } from '../performance/StartupProfiler';
import type { ProviderCommandCatalog } from './commands/ProviderCommandCatalog';
import type { ProviderHost } from './ProviderHost';
import { ProviderInitializationBoundary } from './ProviderInitializationBoundary';
import type {
  AgentMentionProvider,
  ProviderCliResolver,
  ProviderId,
  ProviderModelCatalogRefreshResult,
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
 *
 * Initialization is lazy: providers are only initialized when something first
 * asks for them via `ensureInitialized`. `getServices` returns already-initialized
 * services (or null) so callers can keep synchronous access patterns after they
 * have awaited initialization.
 */
export class ProviderWorkspaceRegistry {
  private static boundary = new ProviderInitializationBoundary();

  static register(
    providerId: ProviderId,
    registration: ProviderWorkspaceRegistration,
  ): void {
    this.boundary.register(providerId, registration);
  }

  static async initializeAll(plugin: ProviderHost): Promise<void> {
    for (const providerId of this.boundary.getRegisteredProviderIds()) {
      try {
        await this.ensureInitialized(plugin, providerId, 'startup');
      } catch {
        // Compatibility path only: one provider must not block the remaining providers.
      }
    }
  }

  static async ensureInitialized(
    plugin: ProviderHost,
    providerId: ProviderId,
    reason: string,
  ): Promise<void> {
    const span = StartupProfiler.start(`provider-init:${providerId}`);
    try {
      await this.boundary.ensureInitialized(plugin, providerId, reason);
    } catch (error) {
      StartupProfiler.increment('provider-init-failures');
      throw error;
    } finally {
      StartupProfiler.finish(span);
    }
  }

  static getIfInitialized(
    providerId: ProviderId,
  ): ProviderWorkspaceServices | null {
    return this.boundary.getIfInitialized(providerId);
  }

  static async disposeInitialized(): Promise<void> {
    await this.boundary.disposeInitialized();
  }

  static setServices(
    providerId: ProviderId,
    services: ProviderWorkspaceServices | undefined,
  ): void {
    this.boundary.setServices(providerId, services);
  }

  static clear(): void {
    this.boundary = new ProviderInitializationBoundary();
  }

  static getServices(
    providerId: ProviderId,
  ): ProviderWorkspaceServices | null {
    return this.getIfInitialized(providerId);
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

  static async refreshModelCatalog(
    providerId: ProviderId,
  ): Promise<ProviderModelCatalogRefreshResult> {
    return await this.getServices(providerId)?.refreshModelCatalog?.() ?? { changed: false };
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

  static async prepareSettings(providerId: ProviderId): Promise<void> {
    await this.getServices(providerId)?.prepareSettings?.();
  }
}
