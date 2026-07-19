import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
  resolvePreferredReasoningDefault,
} from '../../core/providers/reasoning';

export interface KimiDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface KimiModelVariant {
  description?: string;
  label: string;
  value: string;
}

export type KimiThinkingOptionsByModel = Record<string, KimiModelVariant[]>;

export const KIMI_SYNTHETIC_MODEL_ID = 'kimi';
export const KIMI_DEFAULT_THINKING_LEVEL = 'off';
export const KIMI_MODEL_PREFIX = 'kimi:';

export function resolveKimiDefaultThinkingLevel(
  options: KimiModelVariant[],
  preferredValue?: string,
  fallbackValue: string = KIMI_DEFAULT_THINKING_LEVEL,
): string {
  const values = options.map((option) => option.value);
  if (preferredValue && (values.length === 0 || values.includes(preferredValue))) {
    return preferredValue;
  }

  return resolvePreferredReasoningDefault(values, fallbackValue);
}

export function isKimiModelSelectionId(model: string): boolean {
  return model === KIMI_SYNTHETIC_MODEL_ID || model.startsWith(KIMI_MODEL_PREFIX);
}

export function encodeKimiModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${KIMI_MODEL_PREFIX}${normalized}` : KIMI_SYNTHETIC_MODEL_ID;
}

export function decodeKimiModelId(model: string): string | null {
  if (!model.startsWith(KIMI_MODEL_PREFIX)) {
    return null;
  }

  const rawModelId = model.slice(KIMI_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeKimiDiscoveredModels(value: unknown): KimiDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: KimiDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;

    const rawId = typeof record.rawId === 'string'
      ? record.rawId.trim()
      : typeof record.id === 'string'
      ? record.id.trim()
      : '';
    const label = typeof record.label === 'string'
      ? record.label.trim()
      : typeof record.name === 'string'
      ? record.name.trim()
      : rawId;
    const description = typeof record.description === 'string'
      ? record.description.trim()
      : '';

    if (!rawId || seen.has(rawId)) {
      continue;
    }

    seen.add(rawId);
    normalized.push({
      ...(description ? { description } : {}),
      label: label || rawId,
      rawId,
    });
  }

  return normalized;
}

export function normalizeKimiModelVariants(value: unknown): KimiModelVariant[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const variants: KimiModelVariant[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const rawValue = typeof record.value === 'string'
      ? record.value.trim()
      : typeof record.id === 'string'
      ? record.id.trim()
      : '';
    if (!rawValue || seen.has(rawValue)) {
      continue;
    }

    let rawLabel = '';
    if (typeof record.label === 'string') {
      rawLabel = record.label.trim();
    } else if (typeof record.name === 'string') {
      rawLabel = record.name.trim();
    }
    const description = typeof record.description === 'string'
      ? record.description.trim()
      : '';

    seen.add(rawValue);
    variants.push({
      ...(description ? { description } : {}),
      label: rawLabel || formatReasoningValueLabel(rawValue),
      value: rawValue,
    });
  }

  return variants;
}

export function normalizeKimiThinkingOptionsByModel(
  value: unknown,
  discoveredModels: KimiDiscoveredModel[] = [],
): KimiThinkingOptionsByModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const knownIds = new Set(discoveredModels.map((model) => model.rawId));
  const normalized: KimiThinkingOptionsByModel = {};
  for (const [rawId, variants] of Object.entries(value as Record<string, unknown>)) {
    const trimmed = rawId.trim();
    if (!trimmed) {
      continue;
    }
    if (knownIds.size > 0 && !knownIds.has(trimmed)) {
      continue;
    }
    const options = normalizeKimiModelVariants(variants);
    if (options.length > 0) {
      normalized[trimmed] = options;
    }
  }
  return normalized;
}

export function resolveKimiBaseModelRawId(
  rawModelId: string,
  _discoveredModels: KimiDiscoveredModel[] = [],
): string {
  return rawModelId.trim();
}

export function buildKimiBaseModels(
  discoveredModels: KimiDiscoveredModel[],
): KimiDiscoveredModel[] {
  return normalizeKimiDiscoveredModels(discoveredModels);
}

export { DEFAULT_REASONING_VALUE };
