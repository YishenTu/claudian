import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { octoAgentSettingsTabRenderer } from '../ui/OctoAgentSettingsTab';

export type OctoAgentWorkspaceServices = ProviderWorkspaceServices;

export async function createOctoAgentWorkspaceServices(): Promise<OctoAgentWorkspaceServices> {
  return {
    settingsTabRenderer: octoAgentSettingsTabRenderer,
  };
}

export const octoAgentWorkspaceRegistration: ProviderWorkspaceRegistration<OctoAgentWorkspaceServices> = {
  initialize: async () => createOctoAgentWorkspaceServices(),
};

export function maybeGetOctoAgentWorkspaceServices(): OctoAgentWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('octo-agent') as OctoAgentWorkspaceServices | null;
}

export function getOctoAgentWorkspaceServices(): OctoAgentWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('octo-agent') as OctoAgentWorkspaceServices;
}
