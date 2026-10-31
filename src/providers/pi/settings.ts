import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig, getProviderSelectionInputs, setProviderConfig } from '../../core/providers/providerConfig';
import { decodePiConfig, type PiProviderSettings, updatePiConfig } from './config';

/** Reads Pi's configuration from the settings document. */
export function getPiProviderSettings(settings: Record<string, unknown>): PiProviderSettings {
  return decodePiConfig(getProviderConfig(settings, 'pi'), getProviderSelectionInputs(settings, 'pi'));
}

/** Writes Pi's configuration into the settings document. */
export function updatePiProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<PiProviderSettings>,
): PiProviderSettings {
  const config = getProviderConfig(settings, 'pi');
  const next = updatePiConfig(config, getProviderSelectionInputs(settings, 'pi'), updates);
  setProviderConfig(settings, 'pi', config);
  return next;
}

export function projectPiModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getPiProviderSettings(settings);
  const visibleModels = current.visibleModels;
  const selected = new Set(visibleModels);
  const config = {
    ...getProviderConfig(settings, 'pi'),
    visibleModels,
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredThinkingByModel: selectModelMetadata(current.preferredThinkingByModel, selected),
    selectedModels: current.discoveredModels.filter(model => selected.has(model.encodedId)),
  };
  for (const key of ['discoveredModels', 'catalogTimestamp', 'catalogFingerprint', 'availableModes', 'installationMethod', 'wslDistroOverride']) delete (config as Record<string, unknown>)[key];
  return config;
}
