import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { OpencodeAgentMentionProvider } from '../agents/OpencodeAgentMentionProvider';
import { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import { OpencodeCliResolver } from '../runtime/OpencodeCliResolver';
import { OpencodeAgentStorage } from '../storage/OpencodeAgentStorage';
import { opencodeSettingsTabRenderer } from '../ui/OpencodeSettingsTab';
import { OpencodeCommandLoader } from './OpencodeCommandLoader';

export interface OpencodeWorkspaceServices extends ProviderWorkspaceServices {
  agentStorage: OpencodeAgentStorage;
  agentMentionProvider: OpencodeAgentMentionProvider;
  commandCatalog: ProviderCommandCatalog;
  metadataService: OpencodeMetadataService;
}

const opencodeTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createOpencodeWorkspaceServices(
  vaultAdapter: VaultFileAdapter,
  plugin: ProviderHost,
): Promise<OpencodeWorkspaceServices> {
  const agentStorage = new OpencodeAgentStorage(vaultAdapter);
  const agentMentionProvider = new OpencodeAgentMentionProvider(agentStorage);
  const commandCatalog = new OpencodeCommandCatalog();
  const metadataService = new OpencodeMetadataService(plugin, { commandCatalog });

  return {
    agentStorage,
    agentMentionProvider,
    commandCatalog,
    cliResolver: new OpencodeCliResolver(),
    metadataService,
    commandLoader: new OpencodeCommandLoader(metadataService),
    settingsTabRenderer: opencodeSettingsTabRenderer,
    tabWarmupPolicy: opencodeTabWarmupPolicy,
    refreshAgentMentions: async () => {
      await agentMentionProvider.loadAgents();
    },
    prepareSettings: async () => agentMentionProvider.loadAgents(),
    dispose: async () => metadataService.dispose(),
  };
}

export const opencodeWorkspaceRegistration: ProviderWorkspaceRegistration<OpencodeWorkspaceServices> = {
  initialize: async ({ plugin, vaultAdapter }) => (
    createOpencodeWorkspaceServices(vaultAdapter, plugin)
  ),
};

export function maybeGetOpencodeWorkspaceServices(): OpencodeWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('opencode') as OpencodeWorkspaceServices | null;
}

export function getOpencodeWorkspaceServices(): OpencodeWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('opencode') as OpencodeWorkspaceServices;
}
