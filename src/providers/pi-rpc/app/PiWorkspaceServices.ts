import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderSettingsTabRenderer,
  ProviderTabWarmupPolicy,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { PiCommandCatalog } from '../commands/PiCommandCatalog';
import { PiCommandMetadataProbe } from '../execution/PiCommandMetadataProbe';
import type { PiFamilyProfile } from '../PiFamilyProfile';
import { PiCliResolver } from '../runtime/PiCliResolver';
import { PiCommandLoader } from './PiCommandLoader';

export interface PiFamilyWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
  dispose(): Promise<void>;
}

export interface PiFamilyWorkspaceServicesOptions {
  readonly commandMetadataProbe?: PiCommandMetadataProbe;
  readonly settingsTabRenderer: ProviderSettingsTabRenderer;
  readonly tabWarmupPolicy?: ProviderTabWarmupPolicy;
}

const sharedTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createPiFamilyWorkspaceServices(
  profile: PiFamilyProfile,
  plugin: ProviderHost,
  options: PiFamilyWorkspaceServicesOptions,
): Promise<PiFamilyWorkspaceServices> {
  const commandMetadataProbe = options.commandMetadataProbe
    ?? new PiCommandMetadataProbe(profile, plugin);
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook(profile.providerId, {
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
    cliResolver: new PiCliResolver(profile),
    commandCatalog: new PiCommandCatalog(profile.providerId),
    commandLoader: new PiCommandLoader(profile, commandMetadataProbe),
    settingsTabRenderer: options.settingsTabRenderer,
    tabWarmupPolicy: options.tabWarmupPolicy ?? sharedTabWarmupPolicy,
    async dispose() {
      unregisterTransitionHook();
      await commandMetadataProbe.dispose();
    },
  };
}

export function maybeGetPiFamilyWorkspaceServices(
  profile: PiFamilyProfile,
): PiFamilyWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices(profile.providerId) as PiFamilyWorkspaceServices | null;
}

export function getPiFamilyWorkspaceServices(
  profile: PiFamilyProfile,
): PiFamilyWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices(profile.providerId) as PiFamilyWorkspaceServices;
}
