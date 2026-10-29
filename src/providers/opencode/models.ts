import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
} from '../../core/providers/reasoning';

export interface OpencodeDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface OpencodeModelVariant {
  description?: string;
  label: string;
  value: string;
}

export type OpencodeThinkingOptionsByModel = Record<string, OpencodeModelVariant[]>;

export const OPENCODE_DEFAULT_THINKING_LEVEL = 'default';

const OPENCODE_MODEL_PREFIX = 'opencode:';
const OPENCODE_VARIANT_ASCENDING_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
  'xhigh',
] as const;
const OPENCODE_VARIANT_ASCENDING_RANK = new Map<string, number>(
  OPENCODE_VARIANT_ASCENDING_ORDER.map((value, index) => [value, index] as const),
);

export function resolveOpencodeDefaultThinkingLevel(
  options: OpencodeModelVariant[],
  preferredValue?: string,
): string {
  const values = options.map(option => option.value);
  if (preferredValue && preferredValue !== OPENCODE_DEFAULT_THINKING_LEVEL
    && (values.length === 0 || values.includes(preferredValue))) {
    return preferredValue;
  }

  return DEFAULT_REASONING_VALUE;
}

export function isOpencodeModelSelectionId(model: string): boolean {
  return decodeOpencodeModelId(model) !== null;
}

export function encodeOpencodeModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${OPENCODE_MODEL_PREFIX}${normalized}` : '';
}

export function decodeOpencodeModelId(model: string): string | null {
  if (!model.startsWith(OPENCODE_MODEL_PREFIX)) {
    return null;
  }

  const rawModelId = model.slice(OPENCODE_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeOpencodeDiscoveredModels(value: unknown): OpencodeDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: OpencodeDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;

    const rawId = typeof record.rawId === 'string' ? record.rawId.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : rawId;
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

export function normalizeOpencodeModelVariants(value: unknown): OpencodeModelVariant[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const variants: OpencodeModelVariant[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const rawValue = typeof record.value === 'string' ? record.value.trim() : '';
    if (!rawValue) {
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

    variants.push({
      ...(description ? { description } : {}),
      label: rawLabel || formatReasoningValueLabel(rawValue),
      value: rawValue,
    });
  }

  return dedupeOpencodeVariants(variants);
}

export function normalizeOpencodeThinkingOptionsByModel(
  value: unknown,
): OpencodeThinkingOptionsByModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: OpencodeThinkingOptionsByModel = {};
  for (const [rawId, variants] of Object.entries(value as Record<string, unknown>)) {
    const normalizedRawId = rawId.trim();
    const normalizedVariants = normalizeOpencodeModelVariants(variants);
    if (!normalizedRawId || !Array.isArray(variants)) {
      continue;
    }

    Object.defineProperty(normalized, normalizedRawId, { value: normalizedVariants, enumerable: true, writable: true, configurable: true });
  }

  return normalized;
}

export function splitOpencodeModelLabel(label: string): {
  modelLabel: string;
  providerLabel: string;
} {
  const trimmed = label.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return {
      modelLabel: trimmed,
      providerLabel: 'Other',
    };
  }

  return {
    modelLabel: trimmed.slice(slashIndex + 1).trim(),
    providerLabel: trimmed.slice(0, slashIndex).trim(),
  };
}

function dedupeOpencodeVariants(variants: OpencodeModelVariant[]): OpencodeModelVariant[] {
  const unique = new Map<string, OpencodeModelVariant>();
  for (const variant of variants) {
    if (!unique.has(variant.value)) {
      unique.set(variant.value, variant);
    }
  }

  return Array.from(unique.values())
    .sort((left, right) => compareOpencodeVariantValues(left.value, right.value));
}

function compareOpencodeVariantValues(left: string, right: string): number {
  const leftRank = OPENCODE_VARIANT_ASCENDING_RANK.get(left.toLowerCase());
  const rightRank = OPENCODE_VARIANT_ASCENDING_RANK.get(right.toLowerCase());

  if (leftRank !== undefined && rightRank !== undefined) {
    return leftRank - rightRank;
  }

  if (leftRank !== undefined) {
    return -1;
  }

  if (rightRank !== undefined) {
    return 1;
  }

  return left.localeCompare(right);
}
