import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import { OpencodeExecutionSession } from '../execution/OpencodeExecutionSession';
import { OpencodeServerService } from '../http/OpencodeServerService';
import { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import { OpencodeCLIResolver } from '../runtime/OpencodeCLIResolver';
import { createOpencodeModels } from '../runtime/OpencodeModels';
import { OpencodeSharedRuntime } from '../runtime/OpencodeSharedRuntime';
import { getOpencodeProviderSettings } from '../settings';
import { createOpencodeSettingsTabRenderer } from '../ui/OpencodeSettingsTab';
import { OpencodeCommandLoader } from './OpencodeCommandLoader';

export interface OpencodeWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
  metadataService: OpencodeMetadataService;
  serverService: OpencodeServerService;
}

export async function createOpencodeWorkspaceServices(
  plugin: ProviderHost,
): Promise<OpencodeWorkspaceServices> {
  const commandCatalog = new OpencodeCommandCatalog();
  const serverService = new OpencodeServerService();
  const runtime = new OpencodeSharedRuntime(plugin, serverService, version => commandCatalog.setNativeVersion(version));
  const unregister = plugin.executionLifecycleRegistry.registerTransitionHook('opencode', {
    preserveSessions: session => getOpencodeProviderSettings(plugin.settings).enabled
      && session instanceof OpencodeExecutionSession && session.usesSharedRuntime,
    beforeTransition: () => runtime.beginTransition(),
    afterTransition: () => runtime.endTransition(),
  });
  const metadataService = new OpencodeMetadataService(plugin, { commandCatalog, serverService });

  const modelCatalog = createOpencodeModels(plugin, metadataService);
  const unregisterModels = plugin.executionLifecycleRegistry.registerTransitionHook('opencode', { beforeTransition: () => modelCatalog.beginTransition(), afterTransition: () => modelCatalog.endTransition() });
  const cliResolver = new OpencodeCLIResolver();
  return {
    commandCatalog,
    modelCatalog,
    cliResolver,
    metadataService,
    serverService,
    startRuntime: () => runtime.start(),
    commandLoader: new OpencodeCommandLoader(metadataService),
    settingsTabRenderer: createOpencodeSettingsTabRenderer({ cliResolver, metadataService, modelCatalog }),
    dispose: async () => {
      runtime.dispose();
      unregister();
      unregisterModels();
      await Promise.all([metadataService.dispose(), serverService.dispose(), modelCatalog.dispose()]);
    },
  };
}

export const opencodeWorkspaceRegistration: ProviderWorkspaceRegistration<OpencodeWorkspaceServices> = {
  consumesAgentSkills: true,
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
