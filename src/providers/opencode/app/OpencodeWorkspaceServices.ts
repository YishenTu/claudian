import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import { OpencodeServerService } from '../http/OpencodeServerService';
import { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import { OpencodeCliResolver } from '../runtime/OpencodeCliResolver';
import { createOpencodeSettingsTabRenderer } from '../ui/OpencodeSettingsTab';
import { OpencodeCommandLoader } from './OpencodeCommandLoader';

export interface OpencodeWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
  metadataService: OpencodeMetadataService;
  serverService: OpencodeServerService;
}

const opencodeTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createOpencodeWorkspaceServices(
  plugin: ProviderHost,
): Promise<OpencodeWorkspaceServices> {
  const commandCatalog = new OpencodeCommandCatalog();
  const serverService = new OpencodeServerService(plugin);
  const unregister = plugin.executionLifecycleRegistry.registerTransitionHook('opencode', {
    beforeTransition: () => serverService.beginTransition(),
    afterTransition: () => serverService.endTransition(),
  });
  const metadataService = new OpencodeMetadataService(plugin, { commandCatalog, serverService });

  const cliResolver = new OpencodeCliResolver();
  return {
    commandCatalog,
    cliResolver,
    metadataService,
    serverService,
    commandLoader: new OpencodeCommandLoader(metadataService),
    settingsTabRenderer: createOpencodeSettingsTabRenderer({ cliResolver, metadataService }),
    tabWarmupPolicy: opencodeTabWarmupPolicy,
    dispose: async () => {
      unregister();
      await Promise.all([metadataService.dispose(), serverService.dispose()]);
    },
  };
}

export const opencodeWorkspaceRegistration: ProviderWorkspaceRegistration<OpencodeWorkspaceServices> = {
  initialize: async ({ plugin }) => (
    createOpencodeWorkspaceServices(plugin)
  ),
};

export function maybeGetOpencodeWorkspaceServices(): OpencodeWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('opencode') as OpencodeWorkspaceServices | null;
}

export function getOpencodeWorkspaceServices(): OpencodeWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('opencode') as OpencodeWorkspaceServices;
}
