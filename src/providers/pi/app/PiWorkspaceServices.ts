import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { PiCommandCatalog } from '../commands/PiCommandCatalog';
import { PiCliResolver } from '../runtime/PiCliResolver';
import { piSettingsTabRenderer } from '../ui/PiSettingsTab';
import { PiRuntimeCommandLoader } from './PiRuntimeCommandLoader';

export interface PiWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
}

const piTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createPiWorkspaceServices(): Promise<PiWorkspaceServices> {
  return {
    cliResolver: new PiCliResolver(),
    commandCatalog: new PiCommandCatalog(),
    runtimeCommandLoader: new PiRuntimeCommandLoader(),
    settingsTabRenderer: piSettingsTabRenderer,
    tabWarmupPolicy: piTabWarmupPolicy,
  };
}

export const piWorkspaceRegistration: ProviderWorkspaceRegistration<PiWorkspaceServices> = {
  initialize: async () => createPiWorkspaceServices(),
};

export function maybeGetPiWorkspaceServices(): PiWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('pi') as PiWorkspaceServices | null;
}
