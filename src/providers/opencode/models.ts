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

export interface OpencodeBaseModel {
  description?: string;
  label: string;
  rawId: string;
  variants: OpencodeModelVariant[];
}

export interface OpencodeDiscoveredModelGroup {
  models: OpencodeDiscoveredModel[];
  providerKey: string;
  providerLabel: string;
}

export const OPENCODE_SYNTHETIC_MODEL_ID = 'opencode';
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

export function isOpencodeModelSelectionId(model: string): boolean {
  return model === OPENCODE_SYNTHETIC_MODEL_ID || model.startsWith(OPENCODE_MODEL_PREFIX);
}

export function encodeOpencodeModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${OPENCODE_MODEL_PREFIX}${normalized}` : OPENCODE_SYNTHETIC_MODEL_ID;
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

export function resolveOpencodeBaseModelRawId(
  rawId: string,
  discoveredModels: OpencodeDiscoveredModel[] | Set<string>,
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
  return OPENCODE_VARIANT_ASCENDING_RANK.has(variant)
    ? candidate
    : normalizedRawId;
}

export function extractOpencodeModelVariantValue(
  rawId: string,
  discoveredModels: OpencodeDiscoveredModel[] | Set<string>,
): string | null {
  const normalizedRawId = rawId.trim();
  if (!normalizedRawId) {
    return null;
  }

  const baseRawId = resolveOpencodeBaseModelRawId(normalizedRawId, discoveredModels);
  if (baseRawId === normalizedRawId || baseRawId.length >= normalizedRawId.length) {
    return null;
  }

  const variant = normalizedRawId.slice(baseRawId.length + 1).trim();
  return variant || null;
}

export function combineOpencodeRawModelSelection(
  baseRawId: string | null | undefined,
  thinkingLevel: string | null | undefined,
  discoveredModels: OpencodeDiscoveredModel[],
): string | null {
  const normalizedBaseRawId = baseRawId?.trim();
  if (!normalizedBaseRawId) {
    return null;
  }

  const variant = thinkingLevel?.trim();
  if (!variant || variant === OPENCODE_DEFAULT_THINKING_LEVEL) {
    return normalizedBaseRawId;
  }

  const supportedVariants = new Set(
    getOpencodeModelVariants(normalizedBaseRawId, discoveredModels).map((entry) => entry.value),
  );
  return supportedVariants.has(variant)
    ? `${normalizedBaseRawId}/${variant}`
    : normalizedBaseRawId;
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

export function buildOpencodeBaseModels(
  models: OpencodeDiscoveredModel[],
): OpencodeBaseModel[] {
  const discoveredRawIds = new Set(models.map((model) => model.rawId));
  const discoveredByRawId = new Map(models.map((model) => [model.rawId, model] as const));
  const grouped = new Map<string, OpencodeDiscoveredModel[]>();

  for (const model of models) {
    const baseRawId = resolveOpencodeBaseModelRawId(model.rawId, discoveredRawIds);
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

        const variant = extractOpencodeModelVariantValue(entry.rawId, discoveredRawIds);
        if (!variant) {
          return [];
        }

        return [{
          ...(entry.description ? { description: entry.description } : {}),
          label: formatOpencodeThinkingLevelLabel(variant),
          value: variant,
        }];
      });

      return {
        ...(baseModel?.description ? { description: baseModel.description } : {}),
        label: baseModel?.label ?? baseRawId,
        rawId: baseRawId,
        variants: dedupeOpencodeVariants(variants),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function getOpencodeModelVariants(
  rawId: string,
  models: OpencodeDiscoveredModel[],
): OpencodeModelVariant[] {
  const baseRawId = resolveOpencodeBaseModelRawId(rawId, models);
  return buildOpencodeBaseModels(models)
    .find((model) => model.rawId === baseRawId)?.variants ?? [];
}

function formatOpencodeThinkingLevelLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.toLowerCase() === 'xhigh') {
    return 'XHigh';
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function groupOpencodeDiscoveredModels(
  models: OpencodeDiscoveredModel[],
): OpencodeDiscoveredModelGroup[] {
  const groups = new Map<string, OpencodeDiscoveredModelGroup>();
  for (const model of buildOpencodeBaseModels(models)) {
    const { providerLabel } = splitOpencodeModelLabel(model.label || model.rawId);
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
