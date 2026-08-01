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
import { PiCliResolver } from '../runtime/PiCliResolver';
import { piSettingsTabRenderer } from '../ui/PiSettingsTab';
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
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('pi', {
      beforeTransition: () => {
        commandMetadataProbe.beginEnvironmentTransition();
        return commandMetadataProbe.quiesceForEnvironmentChange();
      },
      afterTransition: async () => {
        try {
          await commandMetadataProbe.quiesceForEnvironmentChange();
        } finally {
          commandMetadataProbe.endEnvironmentTransition();
        }
      },
    });

  return {
    cliResolver: new PiCliResolver(),
    commandCatalog: new PiCommandCatalog(),
    commandLoader: new PiCommandLoader(commandMetadataProbe),
    settingsTabRenderer: piSettingsTabRenderer,
    tabWarmupPolicy: piTabWarmupPolicy,
    async dispose() {
      unregisterTransitionHook();
      await commandMetadataProbe.dispose();
    },
  };
}

export const piWorkspaceRegistration: ProviderWorkspaceRegistration<PiWorkspaceServices> = {
  initialize: async ({ plugin }) => createPiWorkspaceServices(plugin),
};

export function maybeGetPiWorkspaceServices(): PiWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('pi') as PiWorkspaceServices | null;
}

export function getPiWorkspaceServices(): PiWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('pi') as PiWorkspaceServices;
}
