import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { KimiCommandCatalog } from '../commands/KimiCommandCatalog';
import { KimiCliResolver } from '../runtime/KimiCliResolver';
import { kimiSettingsTabRenderer } from '../ui/KimiSettingsTab';
import { KimiRuntimeCommandLoader } from './KimiRuntimeCommandLoader';

export interface KimiWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
}

const kimiTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

async function createKimiWorkspaceServices(): Promise<KimiWorkspaceServices> {
  return {
    cliResolver: new KimiCliResolver(),
    commandCatalog: new KimiCommandCatalog(),
    runtimeCommandLoader: new KimiRuntimeCommandLoader(),
    settingsTabRenderer: kimiSettingsTabRenderer,
    tabWarmupPolicy: kimiTabWarmupPolicy,
  };
}

export const kimiWorkspaceRegistration: ProviderWorkspaceRegistration<KimiWorkspaceServices> = {
  initialize: async () => createKimiWorkspaceServices(),
};

export function maybeGetKimiWorkspaceServices(): KimiWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('kimi') as KimiWorkspaceServices | null;
}
