import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import { OpencodeCliResolver } from '../runtime/OpencodeCliResolver';
import { OpencodeAgentStorage } from '../storage/OpencodeAgentStorage';
import { createOpencodeSettingsTabRenderer } from '../ui/OpencodeSettingsTab';
import { OpencodeCommandLoader } from './OpencodeCommandLoader';

export interface OpencodeWorkspaceServices extends ProviderWorkspaceServices {
  agentStorage: OpencodeAgentStorage;
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
  const commandCatalog = new OpencodeCommandCatalog();
  const metadataService = new OpencodeMetadataService(plugin, { commandCatalog });

  const cliResolver = new OpencodeCliResolver();
  return {
    agentStorage,
    commandCatalog,
    cliResolver,
    metadataService,
    commandLoader: new OpencodeCommandLoader(metadataService),
    settingsTabRenderer: createOpencodeSettingsTabRenderer({ cliResolver, agentStorage, metadataService }),
    tabWarmupPolicy: opencodeTabWarmupPolicy,
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
