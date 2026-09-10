import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderWorkspaceRegistration } from '../../../core/providers/types';
import {
  createPiFamilyWorkspaceServices,
  getPiFamilyWorkspaceServices,
  maybeGetPiFamilyWorkspaceServices,
  type PiFamilyWorkspaceServices,
  type PiFamilyWorkspaceServicesOptions,
} from '../../pi-rpc/app/PiWorkspaceServices';
import { piFamilyProfile } from '../profile';
import { piSettingsTabRenderer } from '../ui/PiSettingsTab';

export type PiWorkspaceServices = PiFamilyWorkspaceServices;
export type PiWorkspaceServicesOptions = PiFamilyWorkspaceServicesOptions;

export async function createPiWorkspaceServices(
  plugin: ProviderHost,
  options: Partial<PiWorkspaceServicesOptions> = {},
): Promise<PiWorkspaceServices> {
  return createPiFamilyWorkspaceServices(piFamilyProfile, plugin, {
    ...options,
    settingsTabRenderer: options.settingsTabRenderer ?? piSettingsTabRenderer,
  });
}

export const piWorkspaceRegistration: ProviderWorkspaceRegistration<PiWorkspaceServices> = {
  initialize: async ({ plugin }) => createPiWorkspaceServices(plugin),
};

export function maybeGetPiWorkspaceServices(): PiWorkspaceServices | null {
  return maybeGetPiFamilyWorkspaceServices(piFamilyProfile);
}

export function getPiWorkspaceServices(): PiWorkspaceServices {
  return getPiFamilyWorkspaceServices(piFamilyProfile);
}
