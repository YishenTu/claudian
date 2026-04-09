import type {
  ProviderWorkspaceInitContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { OpenCodeCliResolver } from '../runtime/OpenCodeCliResolver';
import { openCodeSettingsTabRenderer } from '../ui/OpenCodeSettingsTab';

export interface OpenCodeWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: OpenCodeCliResolver;
}

export async function createOpenCodeWorkspaceServices(
  _context: ProviderWorkspaceInitContext
): Promise<OpenCodeWorkspaceServices> {
  const cliResolver = new OpenCodeCliResolver();

  return {
    cliResolver,
    settingsTabRenderer: openCodeSettingsTabRenderer,
  };
}

export const openCodeWorkspaceRegistration: ProviderWorkspaceRegistration<OpenCodeWorkspaceServices> = {
  initialize: createOpenCodeWorkspaceServices,
};
