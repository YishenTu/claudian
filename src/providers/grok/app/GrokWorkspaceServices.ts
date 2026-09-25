import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { GrokCommandCatalog } from '../commands/GrokCommandCatalog';
import { GrokCLIResolver } from '../runtime/GrokCLIResolver';
import { GrokModelCatalogCoordinator } from '../runtime/GrokModelCatalogCoordinator';
import { GrokModelCatalogService } from '../runtime/GrokModelCatalogService';
import { createGrokModels } from '../runtime/GrokModels';
import { grokSettingsTabRenderer } from '../ui/GrokSettingsTab';
import { GrokCommandLoader } from './GrokCommandLoader';
import { GrokCommandMetadataProbe } from './GrokCommandMetadataProbe';

export interface GrokWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: GrokCLIResolver;
  commandCatalog: ProviderCommandCatalog;
  modelCatalogCoordinator: GrokModelCatalogCoordinator;
  dispose(): Promise<void>;
}

export interface GrokWorkspaceServicesOptions {
  readonly commandMetadataProbe?: GrokCommandMetadataProbe;
}

const grokTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createGrokWorkspaceServices(
  plugin: ProviderHost,
  options: GrokWorkspaceServicesOptions = {},
): Promise<GrokWorkspaceServices> {
  const modelCatalogService = new GrokModelCatalogService(plugin);
  const modelCatalogCoordinator = new GrokModelCatalogCoordinator(
    plugin,
    modelCatalogService,
  );
  const commandMetadataProbe = options.commandMetadataProbe
    ?? new GrokCommandMetadataProbe(plugin);
  const modelCatalog = createGrokModels(plugin, modelCatalogCoordinator);
  const unregisterTransitionHook =
    plugin.executionLifecycleRegistry.registerTransitionHook('grok', {
      beforeTransition: async () => {
        modelCatalog.beginTransition();
        modelCatalogCoordinator.beginEnvironmentTransition();
        commandMetadataProbe.beginEnvironmentTransition();
        await Promise.all([
          modelCatalogCoordinator.quiesceForEnvironmentChange(),
          commandMetadataProbe.quiesceForEnvironmentChange(),
        ]);
      },
      afterTransition: async () => {
        try {
          await Promise.all([
            modelCatalogCoordinator.quiesceForEnvironmentChange(),
            commandMetadataProbe.quiesceForEnvironmentChange(),
          ]);
        } finally {
          modelCatalogCoordinator.endEnvironmentTransition();
          commandMetadataProbe.endEnvironmentTransition();
          modelCatalog.endTransition();
        }
      },
    });

  return {
    cliResolver: new GrokCLIResolver(),
    commandCatalog: new GrokCommandCatalog(),
    modelCatalogCoordinator,
    commandLoader: new GrokCommandLoader(commandMetadataProbe),
    settingsTabRenderer: grokSettingsTabRenderer,
    tabWarmupPolicy: grokTabWarmupPolicy,
    modelCatalog,
    async dispose() {
      unregisterTransitionHook();
      await Promise.all([
        modelCatalog.dispose(),
        modelCatalogCoordinator.dispose(),
        commandMetadataProbe.dispose(),
      ]);
    },
  };
}

export const grokWorkspaceRegistration: ProviderWorkspaceRegistration<GrokWorkspaceServices> = {
  initialize: async ({ plugin }) => createGrokWorkspaceServices(plugin),
};

export function getGrokWorkspaceServices(): GrokWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('grok') as GrokWorkspaceServices;
}
