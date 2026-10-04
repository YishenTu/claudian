import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '@/core/providers/types';

import { AntigravityCommandCatalog } from '../commands/AntigravityCommandCatalog';
import { AntigravityBinaryResolver } from '../runtime/AntigravityBinaryResolver';
import { createAntigravitySettingsTab } from '../ui/AntigravitySettingsTab';

export interface AntigravityWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: AntigravityCommandCatalog;
  cliResolver: AntigravityBinaryResolver;
}

export async function createAntigravityWorkspaceServices(
  _plugin: ProviderHost,
): Promise<AntigravityWorkspaceServices> {
  const commandCatalog = new AntigravityCommandCatalog();
  const cliResolver = new AntigravityBinaryResolver();

  return {
    commandCatalog,
    cliResolver,
    settingsTabRenderer: createAntigravitySettingsTab(),
    dispose: async () => {
      cliResolver.reset();
    },
  };
}

export const antigravityWorkspaceRegistration: ProviderWorkspaceRegistration<AntigravityWorkspaceServices> = {
  consumesAgentSkills: false,
  initialize: async ({ plugin }) => createAntigravityWorkspaceServices(plugin),
};

export function maybeGetAntigravityWorkspaceServices(): AntigravityWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('antigravity') as AntigravityWorkspaceServices | null;
}

export function getAntigravityWorkspaceServices(): AntigravityWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('antigravity') as AntigravityWorkspaceServices;
}
