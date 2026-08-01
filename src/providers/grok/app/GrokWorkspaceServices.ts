import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderTransitionOwnerContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { GrokCommandCatalog } from '../commands/GrokCommandCatalog';
import { GrokCliResolver } from '../runtime/GrokCliResolver';
import { GrokModelCatalogCoordinator } from '../runtime/GrokModelCatalogCoordinator';
import { GrokModelCatalogService } from '../runtime/GrokModelCatalogService';
import { grokSettingsTabRenderer } from '../ui/GrokSettingsTab';
import { GrokCommandLoader } from './GrokCommandLoader';
import { GrokCommandMetadataProbe } from './GrokCommandMetadataProbe';

export interface GrokWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: GrokCliResolver;
  commandCatalog: ProviderCommandCatalog;
  modelCatalogCoordinator: GrokModelCatalogCoordinator;
  refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): ReturnType<GrokModelCatalogCoordinator['refreshModelCatalog']>;
  prepareSettings(): Promise<void>;
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
  const unregisterTransitionHook =
    plugin.executionLifecycleRegistry.registerTransitionHook('grok', {
      beforeTransition: async () => {
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
        }
      },
    });

  return {
    cliResolver: new GrokCliResolver(),
    commandCatalog: new GrokCommandCatalog(),
    modelCatalogCoordinator,
    commandLoader: new GrokCommandLoader(commandMetadataProbe),
    settingsTabRenderer: grokSettingsTabRenderer,
    tabWarmupPolicy: grokTabWarmupPolicy,
    refreshModelCatalog: context => modelCatalogCoordinator.refreshModelCatalog(context),
    async prepareSettings() {
      await modelCatalogCoordinator.ensureFresh('settings');
    },
    async dispose() {
      unregisterTransitionHook();
      modelCatalogCoordinator.dispose();
      await Promise.all([
        modelCatalogCoordinator.quiesceForEnvironmentChange(),
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
