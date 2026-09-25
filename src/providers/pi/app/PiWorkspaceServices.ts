import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type {
  ProviderHost,
} from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { PiCommandCatalog } from '../commands/PiCommandCatalog';
import { PiCommandMetadataProbe } from '../execution/PiCommandMetadataProbe';
import { PiCLIResolver } from '../runtime/PiCLIResolver';
import { createPiModels } from '../runtime/PiModels';
import { createPiSettingsTabRenderer } from '../ui/PiSettingsTab';
import { PiCommandLoader } from './PiCommandLoader';

export interface PiWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
  dispose(): Promise<void>;
}

export interface PiWorkspaceServicesOptions {
  readonly commandMetadataProbe?: PiCommandMetadataProbe;
}

const piTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createPiWorkspaceServices(
  plugin: ProviderHost,
  options: PiWorkspaceServicesOptions = {},
): Promise<PiWorkspaceServices> {
  const commandMetadataProbe = options.commandMetadataProbe
    ?? new PiCommandMetadataProbe(plugin);
  const modelCatalog = createPiModels(plugin);
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('pi', {
      beforeTransition: async () => {
        modelCatalog.beginTransition();
        commandMetadataProbe.beginEnvironmentTransition();
        await Promise.all([modelCatalog.quiesce(), commandMetadataProbe.quiesceForEnvironmentChange()]);
      },
      afterTransition: async () => {
        try {
          await commandMetadataProbe.quiesceForEnvironmentChange();
        } finally {
          commandMetadataProbe.endEnvironmentTransition();
          modelCatalog.endTransition();
        }
      },
    });

  const cliResolver = new PiCLIResolver();
  return {
    cliResolver,
    modelCatalog,
    commandCatalog: new PiCommandCatalog(),
    commandLoader: new PiCommandLoader(commandMetadataProbe),
    settingsTabRenderer: createPiSettingsTabRenderer({ cliResolver, modelCatalog }),
    tabWarmupPolicy: piTabWarmupPolicy,
    async dispose() {
      unregisterTransitionHook();
      await Promise.all([commandMetadataProbe.dispose(), modelCatalog.dispose()]);
    },
  };
}

export const piWorkspaceRegistration: ProviderWorkspaceRegistration<PiWorkspaceServices> = {
  initialize: async ({ plugin }) => createPiWorkspaceServices(plugin),
};

export function getPiWorkspaceServices(): PiWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('pi') as PiWorkspaceServices;
}
