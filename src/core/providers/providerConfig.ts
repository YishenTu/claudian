import type { ProviderSelectionDefaults, ProviderSelectionInputs } from './ProviderRuntimeHost';
import type { ProviderId } from './types';

type ProviderConfigMap = Partial<Record<string, Record<string, unknown>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function getProviderConfig(
  settings: Record<string, unknown>,
  providerId: ProviderId,
): Record<string, unknown> {
  const candidate = settings.providerConfigs;
  if (!isRecord(candidate)) {
    return {};
  }

  const config = candidate[providerId];
  return isRecord(config) ? { ...config } : {};
}

export function setProviderConfig(
  settings: Record<string, unknown>,
  providerId: ProviderId,
  config: Record<string, unknown>,
): void {
  const current = settings.providerConfigs;
  const nextConfigs: ProviderConfigMap = isRecord(current)
    ? { ...(current as ProviderConfigMap) }
    : {};

  nextConfigs[providerId] = { ...config };
  settings.providerConfigs = nextConfigs;
}

/** The stored top-level selections, whichever provider they were made for. */
export function getProviderSelectionDefaults(settings: Readonly<Record<string, unknown>>): ProviderSelectionDefaults {
  const read = (key: string): string | undefined => typeof settings[key] === 'string' ? settings[key] : undefined;
  return {
    model: read('model'),
    effortLevel: read('effortLevel'),
    permissionMode: read('permissionMode'),
    serviceTier: read('serviceTier'),
  };
}

/** The preferences saved for one provider, without projection or fallback. */
export function getProviderSavedSelection(
  settings: Readonly<Record<string, unknown>>,
  providerId: ProviderId,
): ProviderSelectionDefaults {
  const read = (key: string): string | undefined => {
    const saved = settings[key];
    const value = isRecord(saved) ? saved[providerId] : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  return {
    model: read('savedProviderModel'),
    effortLevel: read('savedProviderEffort'),
    permissionMode: read('savedProviderPermissionMode'),
    serviceTier: read('savedProviderServiceTier'),
  };
}

/** Selection inputs a provider configuration decoder needs from the settings document. */
export function getProviderSelectionInputs(
  settings: Readonly<Record<string, unknown>>,
  providerId: ProviderId,
): ProviderSelectionInputs {
  const saved = settings.savedProviderModel;
  const savedModel = isRecord(saved) ? saved[providerId] : undefined;
  return {
    ...getProviderSelectionDefaults(settings),
    referencedModelIds: [settings.model, settings.titleGenerationModel, savedModel]
      .filter((id): id is string => typeof id === 'string'),
  };
}

/** Replaces a configuration record's contents in place, so scoped transactions see the writer's exact result. */
export function replaceProviderConfig(
  config: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, next);
}
