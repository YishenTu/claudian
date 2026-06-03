import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type ClaudianPlugin from '../../../main';
import { HermesCommandCatalog } from '../commands/HermesCommandCatalog';
import { HermesCliResolver } from '../runtime/HermesCliResolver';
import { getHermesProviderSettings } from '../settings';
import { HermesSkillStorage } from '../storage/HermesSkillStorage';
import { hermesSettingsTabRenderer } from '../ui/HermesSettingsTab';
import { HermesRuntimeCommandLoader } from './HermesRuntimeCommandLoader';

export interface HermesWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: HermesCliResolver;
}

const hermesTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createHermesWorkspaceServices(
  _vaultAdapter: VaultFileAdapter,
  plugin?: ClaudianPlugin,
): Promise<HermesWorkspaceServices> {
  const getProfile = () => {
    if (!plugin) return '';
    const settings = plugin.settings as Record<string, unknown>;
    return getHermesProviderSettings(settings).profile;
  };

  const skillStorage = new HermesSkillStorage(getProfile);
  const commandCatalog = new HermesCommandCatalog(skillStorage);

  return {
    cliResolver: new HermesCliResolver(),
    commandCatalog,
    runtimeCommandLoader: new HermesRuntimeCommandLoader(),
    settingsTabRenderer: hermesSettingsTabRenderer,
    tabWarmupPolicy: hermesTabWarmupPolicy,
  };
}

export const hermesWorkspaceRegistration: ProviderWorkspaceRegistration<HermesWorkspaceServices> = {
  initialize: async ({ vaultAdapter, plugin }) => createHermesWorkspaceServices(vaultAdapter, plugin),
};

export function maybeGetHermesWorkspaceServices(): HermesWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('hermes') as HermesWorkspaceServices | null;
}
