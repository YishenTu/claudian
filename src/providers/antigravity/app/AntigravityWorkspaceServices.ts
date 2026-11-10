import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { AntigravityCommandCatalog } from '../commands/AntigravityCommandCatalog';
import { AntigravityCLIResolver } from '../runtime/AntigravityCLIResolver';
import { AntigravityModelCatalog } from '../runtime/AntigravityModelCatalog';
import { createAntigravityModels } from '../runtime/AntigravityModels';
import { ANTIGRAVITY_PROVIDER_ID } from '../settings';
import { antigravitySettingsTabRenderer } from '../ui/AntigravitySettingsTab';
import { AntigravityCommandLoader } from './AntigravityCommandLoader';
import { AntigravityMetadataProbe } from './AntigravityMetadataProbe';

export interface AntigravityWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: AntigravityCLIResolver;
  commandCatalog: ProviderCommandCatalog;
  modelCatalogOwner: AntigravityModelCatalog;
  dispose(): Promise<void>;
}

export async function createAntigravityWorkspaceServices(plugin: ProviderHost): Promise<AntigravityWorkspaceServices> {
  const runtimeHost = plugin.getRuntimeHost(ANTIGRAVITY_PROVIDER_ID);
  const metadataProbe = new AntigravityMetadataProbe(runtimeHost);
  const modelCatalogOwner = new AntigravityModelCatalog(runtimeHost, signal => metadataProbe.load(signal));
  const modelCatalog = createAntigravityModels(runtimeHost, modelCatalogOwner);
  const unregisterTransitionHook = plugin.executionLifecycleRegistry.registerTransitionHook(ANTIGRAVITY_PROVIDER_ID, {
    beforeTransition: async () => {
      modelCatalog.beginTransition();
      metadataProbe.beginEnvironmentTransition();
      await metadataProbe.quiesceForEnvironmentChange();
    },
    afterTransition: async () => {
      try {
        await metadataProbe.quiesceForEnvironmentChange();
      } finally {
        metadataProbe.endEnvironmentTransition();
        modelCatalog.endTransition();
      }
    },
  });

  return {
    cliResolver: new AntigravityCLIResolver(),
    commandCatalog: new AntigravityCommandCatalog(),
    commandLoader: new AntigravityCommandLoader(metadataProbe),
    modelCatalog,
    modelCatalogOwner,
    settingsTabRenderer: antigravitySettingsTabRenderer,
    async dispose() {
      unregisterTransitionHook();
      modelCatalogOwner.dispose();
      await Promise.all([modelCatalog.dispose(), metadataProbe.dispose()]);
    },
  };
}

export const antigravityWorkspaceRegistration: ProviderWorkspaceRegistration<AntigravityWorkspaceServices> = {
  consumesAgentSkills: true,
  initialize: async ({ plugin }) => createAntigravityWorkspaceServices(plugin),
};

export function getAntigravityWorkspaceServices(): AntigravityWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices(ANTIGRAVITY_PROVIDER_ID) as AntigravityWorkspaceServices;
}
