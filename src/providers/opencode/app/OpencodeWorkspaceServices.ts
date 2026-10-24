import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import { preservesOpencodeConversationSession } from '../env/OpencodeSettingsReconciler';
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
  const serverService = new OpencodeServerService(plugin.sessionToolEndpoint);
  const runtime = new OpencodeSharedRuntime(plugin, serverService);
  const unregister = plugin.executionLifecycleRegistry.registerTransitionHook('opencode', {
    preserveSessions: (session, { sessionsInvalidated }) => {
      if (!getOpencodeProviderSettings(plugin.settings).enabled) return false;
      if (!(session instanceof OpencodeExecutionSession)) return false;
      if (!sessionsInvalidated) return true;
      // Invalidation retires bindings the provider does not preserve; their sessions end with them.
      const snapshot = session.getSnapshot();
      return preservesOpencodeConversationSession({
        sessionId: snapshot.providerSessionId ?? null,
        providerState: snapshot.providerState,
      });
    },
    beforeTransition: () => runtime.beginTransition(),
    afterTransition: () => runtime.endTransition(),
  });
  const metadataService = new OpencodeMetadataService(plugin, { serverService });

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
