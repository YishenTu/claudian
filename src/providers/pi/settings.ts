import type {
  PersistedPiProviderSettings,
  PiFamilySettingsAccess,
  PiProviderSettings,
  PiToolMode,
} from '../pi-rpc/settings';
import { definePiFamilySettings } from '../pi-rpc/settings';
import { piFamilyModels } from './models';

export type { PersistedPiProviderSettings, PiProviderSettings, PiToolMode };
export { DEFAULT_PI_FAMILY_PROVIDER_SETTINGS as DEFAULT_PI_PROVIDER_SETTINGS } from '../pi-rpc/settings';

export const piFamilySettings: PiFamilySettingsAccess = definePiFamilySettings('pi', piFamilyModels);

export const getPiProviderSettings = piFamilySettings.get;
export const updatePiProviderSettings = piFamilySettings.update;
export const normalizePiVisibleModels = piFamilySettings.normalizeVisibleModels;
export const normalizePiModelAliases = piFamilySettings.normalizeModelAliases;
export const normalizePiPreferredThinkingByModel = piFamilySettings.normalizePreferredThinkingByModel;
export const resolvePiModelAlias = piFamilySettings.resolveModelAlias;
