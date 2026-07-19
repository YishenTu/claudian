import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { KimiCliResolver } from '../runtime/KimiCliResolver';
import { kimiSettingsTabRenderer } from '../ui/KimiSettingsTab';

export interface KimiWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: KimiCliResolver;
}

export async function createKimiWorkspaceServices(): Promise<KimiWorkspaceServices> {
  return {
    cliResolver: new KimiCliResolver(),
    settingsTabRenderer: kimiSettingsTabRenderer,
  };
}

export const kimiWorkspaceRegistration: ProviderWorkspaceRegistration<KimiWorkspaceServices> = {
  initialize: async () => createKimiWorkspaceServices(),
};

export function maybeGetKimiWorkspaceServices(): KimiWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('kimi') as KimiWorkspaceServices | null;
}
