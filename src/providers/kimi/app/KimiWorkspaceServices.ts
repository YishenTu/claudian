import { McpServerManager } from '../../../core/mcp/McpServerManager';
import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderTabWarmupPolicy,
  ProviderTransitionOwnerContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { KimiAgentMentionProvider } from '../agents/KimiAgentMentionProvider';
import { KimiAgentStorage } from '../agents/KimiAgentStorage';
import { KimiCommandCatalog } from '../commands/KimiCommandCatalog';
import { KimiCliResolver } from '../runtime/KimiCliResolver';
import { KimiMcpStorage } from '../storage/KimiMcpStorage';
import { kimiSettingsTabRenderer } from '../ui/KimiSettingsTab';
import { refreshKimiModelCatalog } from './KimiModelCatalogRefresh';
import { KimiRuntimeCommandLoader } from './KimiRuntimeCommandLoader';

export interface KimiWorkspaceServices extends ProviderWorkspaceServices {
  agentMentionProvider: KimiAgentMentionProvider;
  agentStorage: KimiAgentStorage;
  commandCatalog: ProviderCommandCatalog;
  mcpServerManager: McpServerManager;
  mcpStorage: KimiMcpStorage;
  refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): Promise<ProviderModelCatalogRefreshResult>;
}

const kimiTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createKimiWorkspaceServices(
  plugin: ProviderHost,
  vaultAdapter: VaultFileAdapter,
): Promise<KimiWorkspaceServices> {
  const agentStorage = new KimiAgentStorage(vaultAdapter);
  const agentMentionProvider = new KimiAgentMentionProvider(agentStorage);
  const mcpStorage = new KimiMcpStorage(vaultAdapter);
  const mcpServerManager = new McpServerManager(mcpStorage);

  return {
    agentMentionProvider,
    agentStorage,
    cliResolver: new KimiCliResolver(),
    commandCatalog: new KimiCommandCatalog(),
    mcpServerManager,
    mcpStorage,
    refreshModelCatalog: () => refreshKimiModelCatalog(plugin),
    runtimeCommandLoader: new KimiRuntimeCommandLoader(),
    settingsTabRenderer: kimiSettingsTabRenderer,
    tabWarmupPolicy: kimiTabWarmupPolicy,
    refreshAgentMentions: async () => {
      await agentMentionProvider.loadAgents();
    },
    prepareSettings: async () => {
      await Promise.all([
        agentMentionProvider.loadAgents(),
        mcpServerManager.loadServers(),
      ]);
    },
  };
}

export const kimiWorkspaceRegistration: ProviderWorkspaceRegistration<KimiWorkspaceServices> = {
  initialize: async ({ plugin, vaultAdapter }) => createKimiWorkspaceServices(plugin, vaultAdapter),
};

export function maybeGetKimiWorkspaceServices(): KimiWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('kimi') as KimiWorkspaceServices | null;
}
