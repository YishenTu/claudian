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

/** Each selection field and the settings key that saves it per provider. */
const SAVED_SELECTION_KEYS = {
  model: 'savedProviderModel',
  effortLevel: 'savedProviderEffort',
  permissionMode: 'savedProviderPermissionMode',
  serviceTier: 'savedProviderServiceTier',
} as const satisfies Record<keyof ProviderSelectionDefaults, string>;

function readSelection(
  read: (field: keyof ProviderSelectionDefaults, savedKey: string) => unknown,
): ProviderSelectionDefaults {
  const selection: Record<string, string | undefined> = {};
  for (const [field, savedKey] of Object.entries(SAVED_SELECTION_KEYS)) {
    const value = read(field as keyof ProviderSelectionDefaults, savedKey);
    selection[field] = typeof value === 'string' ? value : undefined;
  }
  return selection;
}

/** The stored top-level selections, whichever provider they were made for. */
export function getProviderSelectionDefaults(settings: Readonly<Record<string, unknown>>): ProviderSelectionDefaults {
  return readSelection(field => settings[field]);
}

/** The preferences saved for one provider, without projection or fallback. */
export function getProviderSavedSelection(
  settings: Readonly<Record<string, unknown>>,
  providerId: ProviderId,
): ProviderSelectionDefaults {
  return readSelection((_field, savedKey) => {
    const saved = settings[savedKey];
    return isRecord(saved) ? saved[providerId] : undefined;
  });
}

/** Selection inputs a provider configuration decoder needs from the settings document. */
export function getProviderSelectionInputs(
  settings: Readonly<Record<string, unknown>>,
  providerId: ProviderId,
): ProviderSelectionInputs {
  return {
    ...getProviderSelectionDefaults(settings),
    referencedModelIds: [settings.model, settings.titleGenerationModel, getProviderSavedSelection(settings, providerId).model]
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
