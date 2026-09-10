import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderWorkspaceRegistration } from '../../../core/providers/types';
import {
  createPiFamilyWorkspaceServices,
  getPiFamilyWorkspaceServices,
  maybeGetPiFamilyWorkspaceServices,
  type PiFamilyWorkspaceServices,
  type PiFamilyWorkspaceServicesOptions,
} from '../../pi-rpc/app/PiWorkspaceServices';
import { ompFamilyProfile } from '../profile';
import { ompSettingsTabRenderer } from '../ui/OmpSettingsTab';

export type OmpWorkspaceServices = PiFamilyWorkspaceServices;
export type OmpWorkspaceServicesOptions = PiFamilyWorkspaceServicesOptions;

export async function createOmpWorkspaceServices(
  plugin: ProviderHost,
  options: Partial<OmpWorkspaceServicesOptions> = {},
): Promise<OmpWorkspaceServices> {
  return createPiFamilyWorkspaceServices(ompFamilyProfile, plugin, {
    ...options,
    settingsTabRenderer: options.settingsTabRenderer ?? ompSettingsTabRenderer,
  });
}

export const ompWorkspaceRegistration: ProviderWorkspaceRegistration<OmpWorkspaceServices> = {
  initialize: async ({ plugin }) => createOmpWorkspaceServices(plugin),
};

export function maybeGetOmpWorkspaceServices(): OmpWorkspaceServices | null {
  return maybeGetPiFamilyWorkspaceServices(ompFamilyProfile);
}

export function getOmpWorkspaceServices(): OmpWorkspaceServices {
  return getPiFamilyWorkspaceServices(ompFamilyProfile);
}
