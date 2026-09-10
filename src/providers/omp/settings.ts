import type {
  PersistedPiProviderSettings,
  PiFamilySettingsAccess,
  PiProviderSettings,
  PiToolMode,
} from '../pi-rpc/settings';
import { definePiFamilySettings } from '../pi-rpc/settings';
import { ompFamilyModels } from './models';

export type { PersistedPiProviderSettings, PiProviderSettings, PiToolMode };
export { DEFAULT_PI_FAMILY_PROVIDER_SETTINGS as DEFAULT_OMP_PROVIDER_SETTINGS } from '../pi-rpc/settings';

export const ompFamilySettings: PiFamilySettingsAccess = definePiFamilySettings('omp', ompFamilyModels);

export const getOmpProviderSettings = ompFamilySettings.get;
export const updateOmpProviderSettings = ompFamilySettings.update;
export const normalizeOmpVisibleModels = ompFamilySettings.normalizeVisibleModels;
export const normalizeOmpModelAliases = ompFamilySettings.normalizeModelAliases;
export const normalizeOmpPreferredThinkingByModel = ompFamilySettings.normalizePreferredThinkingByModel;
export const resolveOmpModelAlias = ompFamilySettings.resolveModelAlias;
