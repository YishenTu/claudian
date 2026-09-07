import {
  DEFAULT_REASONING_VALUE,
  resolvePreferredReasoningDefault,
} from '../../core/providers/reasoning';
import { toCodexRuntimeModelId } from './modelSelection';
import { formatCodexModelLabel } from './types/models';

export interface CodexReasoningEffortOption {
  value: string;
  description: string;
}

export interface CodexModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexDiscoveredModel {
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: string;
  serviceTiers: CodexModelServiceTier[];
  defaultServiceTier: string | null;
  inputModalities: Array<'text' | 'image'>;
  isDefault: boolean;
}

export const CODEX_FALLBACK_REASONING_EFFORT_VALUES = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const DEFAULT_INPUT_MODALITIES: Array<'text' | 'image'> = ['text', 'image'];
const ULTRA_REASONING_EFFORT = 'ultra';
export const CODEX_DEFAULT_SERVICE_TIER = 'default';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizeReasoningEfforts(value: unknown): CodexReasoningEffortOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const efforts: CodexReasoningEffortOption[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const effort = normalizeNonEmptyString(entry.value ?? entry.reasoningEffort);
    if (!effort || seen.has(effort)) {
      continue;
    }

    seen.add(effort);
    efforts.push({
      value: effort,
      description: normalizeNonEmptyString(entry.description) ?? '',
    });
  }

  return efforts;
}

function normalizeServiceTiers(value: unknown): CodexModelServiceTier[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const tiers: CodexModelServiceTier[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const id = normalizeNonEmptyString(entry.id);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    tiers.push({
      id,
      name: normalizeNonEmptyString(entry.name) ?? id,
      description: normalizeNonEmptyString(entry.description) ?? '',
    });
  }

  return tiers;
}

function normalizeInputModalities(value: unknown): Array<'text' | 'image'> {
  if (value === undefined) {
    return [...DEFAULT_INPUT_MODALITIES];
  }
  if (!Array.isArray(value)) {
    return [];
  }

  const modalities = new Set<'text' | 'image'>();
  for (const entry of value) {
    if (typeof entry === 'string' && (entry === 'text' || entry === 'image')) {
      modalities.add(entry);
    }
  }
  return Array.from(modalities);
}

export function normalizeCodexDiscoveredModels(value: unknown): CodexDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const models: CodexDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || entry.hidden === true) {
      continue;
    }

    const model = normalizeNonEmptyString(entry.model ?? entry.id);
    if (!model || seen.has(model)) {
      continue;
    }

    const supportedReasoningEfforts = normalizeReasoningEfforts(entry.supportedReasoningEfforts);
    const defaultReasoningEffort = normalizeNonEmptyString(entry.defaultReasoningEffort);
    if (
      !defaultReasoningEffort
      || !supportedReasoningEfforts.some(option => option.value === defaultReasoningEffort)
    ) {
      continue;
    }

    const serviceTiers = normalizeServiceTiers(entry.serviceTiers);
    const defaultServiceTier = normalizeNonEmptyString(entry.defaultServiceTier);

    seen.add(model);
    models.push({
      model,
      displayName: normalizeNonEmptyString(entry.displayName) ?? formatCodexModelLabel(model),
      description: normalizeNonEmptyString(entry.description) ?? '',
      supportedReasoningEfforts,
      defaultReasoningEffort,
      serviceTiers,
      defaultServiceTier,
      inputModalities: normalizeInputModalities(entry.inputModalities),
      isDefault: entry.isDefault === true,
    });
  }

  return models;
}

export function findCodexModel(
  models: CodexDiscoveredModel[],
  modelId: string | undefined,
): CodexDiscoveredModel | null {
  if (!modelId) {
    return null;
  }

  const runtimeModelId = toCodexRuntimeModelId(modelId);
  return models.find(model => model.model === runtimeModelId) ?? null;
}

export function getDefaultCodexModel(
  models: CodexDiscoveredModel[],
): CodexDiscoveredModel | null {
  return models.find(model => model.isDefault) ?? models[0] ?? null;
}

export function getCodexModelsInPickerOrder(
  models: CodexDiscoveredModel[],
): CodexDiscoveredModel[] {
  return [...models].reverse();
}

export function getCodexDefaultReasoningEffort(
  model: CodexDiscoveredModel,
  enableUltraEffort: boolean,
): string | null {
  const supportedReasoningEfforts = getCodexReasoningEffortOptions(model, enableUltraEffort);
  const supportedValues = supportedReasoningEfforts.map(option => option.value);
  if (supportedValues.length === 0) {
    return null;
  }
  const fallbackValue = supportedValues.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : DEFAULT_REASONING_VALUE;
  return resolvePreferredReasoningDefault(
    supportedValues,
    fallbackValue,
  );
}

export function getCodexReasoningEffortOptions(
  model: CodexDiscoveredModel,
  enableUltraEffort: boolean,
): CodexReasoningEffortOption[] {
  return enableUltraEffort
    ? model.supportedReasoningEfforts
    : model.supportedReasoningEfforts.filter(
      option => option.value.toLowerCase() !== ULTRA_REASONING_EFFORT,
    );
}

export function isCodexModelAvailable(
  model: CodexDiscoveredModel,
  enableUltraEffort: boolean,
): boolean {
  return getCodexReasoningEffortOptions(model, enableUltraEffort).length > 0;
}

export function resolveCodexReasoningEffort(
  model: CodexDiscoveredModel | null,
  enableUltraEffort: boolean,
  requestedEffort: string | null,
): string | null {
  if (!model) {
    const fallbackValues: readonly string[] = CODEX_FALLBACK_REASONING_EFFORT_VALUES;
    return requestedEffort && fallbackValues.includes(requestedEffort)
      ? requestedEffort
      : resolvePreferredReasoningDefault(fallbackValues, DEFAULT_REASONING_VALUE);
  }

  const supportedValues = getCodexReasoningEffortOptions(model, enableUltraEffort)
    .map(option => option.value);
  if (requestedEffort && supportedValues.includes(requestedEffort)) {
    return requestedEffort;
  }
  return getCodexDefaultReasoningEffort(model, enableUltraEffort);
}

export function getCodexFastServiceTier(
  model: CodexDiscoveredModel,
): CodexModelServiceTier | null {
  return model.serviceTiers.find(tier => tier.name.trim().toLowerCase() === 'fast') ?? null;
}

export function resolveCodexModelServiceTier(
  model: CodexDiscoveredModel | null,
  selectedServiceTier: unknown,
): string | null {
  if (!model) {
    return null;
  }
  // "default" is an explicit Standard selection, distinct from the catalog default.
  if (selectedServiceTier === CODEX_DEFAULT_SERVICE_TIER) {
    return CODEX_DEFAULT_SERVICE_TIER;
  }
  if (typeof selectedServiceTier === 'string') {
    if (model.serviceTiers.some(tier => tier.id === selectedServiceTier)) {
      return selectedServiceTier;
    }
    if (selectedServiceTier === 'fast') {
      return getCodexFastServiceTier(model)?.id ?? null;
    }
  }
  return model.defaultServiceTier;
}
