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

const DEFAULT_INPUT_MODALITIES: Array<'text' | 'image'> = ['text', 'image'];
const EXCLUDED_REASONING_EFFORTS = new Set(['ultra']);

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
    if (!effort || EXCLUDED_REASONING_EFFORTS.has(effort.toLowerCase()) || seen.has(effort)) {
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
    if (entry === 'text' || entry === 'image') {
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
    let defaultReasoningEffort = normalizeNonEmptyString(entry.defaultReasoningEffort);
    if (
      !defaultReasoningEffort
      || !supportedReasoningEfforts.some(option => option.value === defaultReasoningEffort)
    ) {
      if (
        defaultReasoningEffort
        && EXCLUDED_REASONING_EFFORTS.has(defaultReasoningEffort.toLowerCase())
        && supportedReasoningEfforts.length > 0
      ) {
        defaultReasoningEffort = resolvePreferredReasoningDefault(
          supportedReasoningEfforts.map(option => option.value),
          supportedReasoningEfforts[0].value,
        );
      } else {
        continue;
      }
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
): string {
  return resolvePreferredReasoningDefault(
    model.supportedReasoningEfforts.map(option => option.value),
    model.defaultReasoningEffort || DEFAULT_REASONING_VALUE,
  );
}

export function getCodexFastServiceTier(
  model: CodexDiscoveredModel,
): CodexModelServiceTier | null {
  return model.serviceTiers.find(tier => tier.name.trim().toLowerCase() === 'fast') ?? null;
}
