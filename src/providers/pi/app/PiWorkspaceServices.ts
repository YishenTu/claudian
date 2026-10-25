import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type {
  ProviderHost,
} from '../../../core/providers/ProviderHost';
import type {
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

export async function createPiWorkspaceServices(
  plugin: ProviderHost,
  options: PiWorkspaceServicesOptions = {},
): Promise<PiWorkspaceServices> {
  const runtimeHost = plugin.getRuntimeHost('pi');
  const commandMetadataProbe = options.commandMetadataProbe
    ?? new PiCommandMetadataProbe(runtimeHost);
  const modelCatalog = createPiModels(runtimeHost);
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
    async dispose() {
      unregisterTransitionHook();
      await Promise.all([commandMetadataProbe.dispose(), modelCatalog.dispose()]);
    },
  };
}

export const piWorkspaceRegistration: ProviderWorkspaceRegistration<PiWorkspaceServices> = {
  consumesAgentSkills: true,
  initialize: async ({ plugin }) => createPiWorkspaceServices(plugin),
};
