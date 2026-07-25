export interface KimiDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface KimiThinkingOption {
  description?: string;
  label: string;
  value: string;
}

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

export function normalizeKimiThinkingOptions(value: unknown): KimiThinkingOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: KimiThinkingOption[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;

    const optionValue = typeof record.value === 'string' ? record.value.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : optionValue;
    const description = typeof record.description === 'string'
      ? record.description.trim()
      : '';

    if (!optionValue || seen.has(optionValue)) {
      continue;
    }

    seen.add(optionValue);
    normalized.push({
      ...(description ? { description } : {}),
      label: label || optionValue,
      value: optionValue,
    });
  }

  return normalized;
}

// Pick the effort the UI should show: the user's stored preference first, then the
// session-reported level, then 'off' (the only level every non-always-thinking
// picker carries), then the first advertised row.
export function resolveKimiThinkingLevel(
  options: KimiThinkingOption[],
  preferredValue?: string | null,
  currentValue?: string | null,
): string {
  const values = new Set(options.map((option) => option.value));
  if (preferredValue && values.has(preferredValue)) {
    return preferredValue;
  }
  if (currentValue && values.has(currentValue)) {
    return currentValue;
  }
  if (values.has('off')) {
    return 'off';
  }
  return options[0]?.value ?? '';
}
