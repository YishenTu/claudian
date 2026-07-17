import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { GrokCliResolver } from '../runtime/GrokCliResolver';
import { grokSettingsTabRenderer } from '../ui/GrokSettingsTab';

export interface GrokWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: GrokCliResolver;
}

export async function createGrokWorkspaceServices(): Promise<GrokWorkspaceServices> {
  return {
    cliResolver: new GrokCliResolver(),
    settingsTabRenderer: grokSettingsTabRenderer,
  };
}

export const grokWorkspaceRegistration: ProviderWorkspaceRegistration<GrokWorkspaceServices> = {
  initialize: async () => createGrokWorkspaceServices(),
};

export function maybeGetGrokWorkspaceServices(): GrokWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('grok') as GrokWorkspaceServices | null;
}
