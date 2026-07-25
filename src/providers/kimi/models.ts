export interface KimiDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

// Kimi ACP advertises thinking as a model variant with this suffix on the base model id.
export const KIMI_THINKING_MODEL_SUFFIX = ',thinking';

const KIMI_MODEL_PREFIX = 'kimi:';

export function isKimiModelSelectionId(model: string): boolean {
  return decodeKimiModelId(model) !== null;
}

export function encodeKimiModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${KIMI_MODEL_PREFIX}${normalized}` : '';
}

export function decodeKimiModelId(model: string): string | null {
  if (!model.startsWith(KIMI_MODEL_PREFIX)) {
    return null;
  }

  const rawModelId = model.slice(KIMI_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function isKimiThinkingModelId(rawModelId: string): boolean {
  return rawModelId.trim().endsWith(KIMI_THINKING_MODEL_SUFFIX);
}

export function resolveKimiBaseModelRawId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return isKimiThinkingModelId(normalized)
    ? normalized.slice(0, -KIMI_THINKING_MODEL_SUFFIX.length)
    : normalized;
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
