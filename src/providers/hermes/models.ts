export interface HermesDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface HermesModelVariant {
  description?: string;
  label: string;
  value: string;
}

export interface HermesBaseModel {
  description?: string;
  label: string;
  rawId: string;
  variants: HermesModelVariant[];
}

export const HERMES_DEFAULT_THINKING_LEVEL = 'default';

const HERMES_MODEL_PREFIX = 'hermes:';

export function isHermesModelSelectionId(model: string): boolean {
  return model === 'hermes' || model.startsWith(HERMES_MODEL_PREFIX);
}

export function encodeHermesModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${HERMES_MODEL_PREFIX}${normalized}` : 'hermes';
}

export function decodeHermesModelId(model: string): string | null {
  if (!model.startsWith(HERMES_MODEL_PREFIX)) {
    return null;
  }

  const rawModelId = model.slice(HERMES_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeHermesDiscoveredModels(
  value: unknown,
): HermesDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: HermesDiscoveredModel[] = [];
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

export function resolveHermesBaseModelRawId(rawId: string): string {
  const normalizedRawId = rawId.trim();
  if (!normalizedRawId) {
    return '';
  }
  return normalizedRawId;
}

export function splitHermesModelLabel(label: string): {
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

export function groupHermesDiscoveredModels(
  models: HermesDiscoveredModel[],
): { models: HermesDiscoveredModel[]; providerKey: string; providerLabel: string }[] {
  const groups = new Map<string, { models: HermesDiscoveredModel[]; providerKey: string; providerLabel: string }>();

  for (const model of models) {
    const { providerLabel } = splitHermesModelLabel(model.label || model.rawId);
    const providerKey = providerLabel.toLowerCase();
    const existing = groups.get(providerKey);
    if (existing) {
      existing.models.push(model);
      continue;
    }

    groups.set(providerKey, {
      models: [model],
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
