import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { OpencodeCliResolver } from '../runtime/OpencodeCliResolver';
import { opencodeSettingsTabRenderer } from '../ui/OpencodeSettingsTab';

export async function createOpencodeWorkspaceServices(): Promise<ProviderWorkspaceServices> {
  return {
    cliResolver: new OpencodeCliResolver(),
    settingsTabRenderer: opencodeSettingsTabRenderer,
  };
}

export const opencodeWorkspaceRegistration: ProviderWorkspaceRegistration = {
  initialize: async () => createOpencodeWorkspaceServices(),
};

export function maybeGetOpencodeWorkspaceServices(): ProviderWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('opencode');
}
