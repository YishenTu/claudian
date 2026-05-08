export interface GeminiDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface GeminiModelVariant {
  description?: string;
  label: string;
  value: string;
}

export interface GeminiBaseModel {
  description?: string;
  label: string;
  rawId: string;
  variants: GeminiModelVariant[];
}

export interface GeminiDiscoveredModelGroup {
  models: GeminiDiscoveredModel[];
  providerKey: string;
  providerLabel: string;
}

export const GEMINI_SYNTHETIC_MODEL_ID = 'gemini';
export const GEMINI_DEFAULT_THINKING_LEVEL = 'default';

const GEMINI_MODEL_PREFIX = 'gemini:';
const GEMINI_VARIANT_ASCENDING_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
  'xhigh',
] as const;
const GEMINI_VARIANT_ASCENDING_RANK = new Map<string, number>(
  GEMINI_VARIANT_ASCENDING_ORDER.map((value, index) => [value, index] as const),
);

export function isGeminiModelSelectionId(model: string): boolean {
  return model === GEMINI_SYNTHETIC_MODEL_ID || model.startsWith(GEMINI_MODEL_PREFIX);
}

export function encodeGeminiModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${GEMINI_MODEL_PREFIX}${normalized}` : GEMINI_SYNTHETIC_MODEL_ID;
}

export function decodeGeminiModelId(model: string): string | null {
  if (!model.startsWith(GEMINI_MODEL_PREFIX)) {
    return null;
  }

  const rawModelId = model.slice(GEMINI_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeGeminiDiscoveredModels(value: unknown): GeminiDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: GeminiDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const rawId = typeof entry.rawId === 'string' ? entry.rawId.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : rawId;
    const description = typeof entry.description === 'string'
      ? entry.description.trim()
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

export function resolveGeminiBaseModelRawId(
  rawId: string,
  discoveredModels: GeminiDiscoveredModel[] | Set<string>,
): string {
  const normalizedRawId = rawId.trim();
  if (!normalizedRawId) {
    return '';
  }

  const discoveredRawIds = discoveredModels instanceof Set
    ? discoveredModels
    : new Set(discoveredModels.map((model) => model.rawId));
  const slashIndex = normalizedRawId.lastIndexOf('/');
  if (slashIndex <= 0) {
    return normalizedRawId;
  }

  const candidate = normalizedRawId.slice(0, slashIndex);
  if (discoveredRawIds.has(candidate)) {
    return candidate;
  }

  const variant = normalizedRawId.slice(slashIndex + 1).trim().toLowerCase();
  return GEMINI_VARIANT_ASCENDING_RANK.has(variant)
    ? candidate
    : normalizedRawId;
}

export function extractGeminiModelVariantValue(
  rawId: string,
  discoveredModels: GeminiDiscoveredModel[] | Set<string>,
): string | null {
  const normalizedRawId = rawId.trim();
  if (!normalizedRawId) {
    return null;
  }

  const baseRawId = resolveGeminiBaseModelRawId(normalizedRawId, discoveredModels);
  if (baseRawId === normalizedRawId || baseRawId.length >= normalizedRawId.length) {
    return null;
  }

  const variant = normalizedRawId.slice(baseRawId.length + 1).trim();
  return variant || null;
}

export function combineGeminiRawModelSelection(
  baseRawId: string | null | undefined,
  thinkingLevel: string | null | undefined,
  discoveredModels: GeminiDiscoveredModel[],
): string | null {
  const normalizedBaseRawId = baseRawId?.trim();
  if (!normalizedBaseRawId) {
    return null;
  }

  const variant = thinkingLevel?.trim();
  if (!variant || variant === GEMINI_DEFAULT_THINKING_LEVEL) {
    return normalizedBaseRawId;
  }

  const supportedVariants = new Set(
    getGeminiModelVariants(normalizedBaseRawId, discoveredModels).map((entry) => entry.value),
  );
  return supportedVariants.has(variant)
    ? `${normalizedBaseRawId}/${variant}`
    : normalizedBaseRawId;
}

export function splitGeminiModelLabel(label: string): {
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

export function buildGeminiBaseModels(
  models: GeminiDiscoveredModel[],
): GeminiBaseModel[] {
  const discoveredRawIds = new Set(models.map((model) => model.rawId));
  const discoveredByRawId = new Map(models.map((model) => [model.rawId, model] as const));
  const grouped = new Map<string, GeminiDiscoveredModel[]>();

  for (const model of models) {
    const baseRawId = resolveGeminiBaseModelRawId(model.rawId, discoveredRawIds);
    const existing = grouped.get(baseRawId);
    if (existing) {
      existing.push(model);
    } else {
      grouped.set(baseRawId, [model]);
    }
  }

  return Array.from(grouped.entries())
    .map(([baseRawId, entries]) => {
      const baseModel = discoveredByRawId.get(baseRawId) ?? entries[0];
      const variants = entries.flatMap((entry) => {
        if (entry.rawId === baseRawId) {
          return [];
        }

        const variant = extractGeminiModelVariantValue(entry.rawId, discoveredRawIds);
        if (!variant) {
          return [];
        }

        return [{
          ...(entry.description ? { description: entry.description } : {}),
          label: formatGeminiThinkingLevelLabel(variant),
          value: variant,
        }];
      });

      return {
        ...(baseModel?.description ? { description: baseModel.description } : {}),
        label: baseModel?.label ?? baseRawId,
        rawId: baseRawId,
        variants: dedupeGeminiVariants(variants),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function getGeminiModelVariants(
  rawId: string,
  models: GeminiDiscoveredModel[],
): GeminiModelVariant[] {
  const baseRawId = resolveGeminiBaseModelRawId(rawId, models);
  return buildGeminiBaseModels(models)
    .find((model) => model.rawId === baseRawId)?.variants ?? [];
}

function formatGeminiThinkingLevelLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.toLowerCase() === 'xhigh') {
    return 'XHigh';
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function groupGeminiDiscoveredModels(
  models: GeminiDiscoveredModel[],
): GeminiDiscoveredModelGroup[] {
  const groups = new Map<string, GeminiDiscoveredModelGroup>();
  for (const model of buildGeminiBaseModels(models)) {
    const { providerLabel } = splitGeminiModelLabel(model.label || model.rawId);
    const providerKey = providerLabel.toLowerCase();
    const existing = groups.get(providerKey);
    if (existing) {
      existing.models.push({
        ...(model.description ? { description: model.description } : {}),
        label: model.label,
        rawId: model.rawId,
      });
      continue;
    }

    groups.set(providerKey, {
      models: [{
        ...(model.description ? { description: model.description } : {}),
        label: model.label,
        rawId: model.rawId,
      }],
      providerKey,
      providerLabel,
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      models: [...group.models].sort((left, right) => left.label.localeCompare(right.label)),
    }))
    .sort((left, right) => left.providerLabel.localeCompare(right.providerLabel));
}

function dedupeGeminiVariants(variants: GeminiModelVariant[]): GeminiModelVariant[] {
  const unique = new Map<string, GeminiModelVariant>();
  for (const variant of variants) {
    if (!unique.has(variant.value)) {
      unique.set(variant.value, variant);
    }
  }

  return Array.from(unique.values())
    .sort((left, right) => compareGeminiVariantValues(left.value, right.value));
}

function compareGeminiVariantValues(left: string, right: string): number {
  const leftRank = GEMINI_VARIANT_ASCENDING_RANK.get(left.toLowerCase());
  const rightRank = GEMINI_VARIANT_ASCENDING_RANK.get(right.toLowerCase());

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
