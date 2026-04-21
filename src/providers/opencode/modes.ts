export interface OpencodeMode {
  description?: string;
  id: string;
  name: string;
}

export const OPENCODE_FALLBACK_MODES: ReadonlyArray<OpencodeMode> = Object.freeze([
  {
    description: 'The default agent. Executes tools based on configured permissions.',
    id: 'build',
    name: 'build',
  },
  {
    description: 'Plan mode. Disallows all edit tools.',
    id: 'plan',
    name: 'plan',
  },
]);

const OPENCODE_MANAGED_MODE_IDS = new Set(OPENCODE_FALLBACK_MODES.map((mode) => mode.id));

export function normalizeOpencodeAvailableModes(value: unknown): OpencodeMode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: OpencodeMode[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : id;
    const description = typeof entry.description === 'string'
      ? entry.description.trim()
      : '';

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push({
      ...(description ? { description } : {}),
      id,
      name: name || id,
    });
  }

  return normalized;
}

export function getEffectiveOpencodeModes(modes: OpencodeMode[]): OpencodeMode[] {
  return modes.length > 0 ? modes : [...OPENCODE_FALLBACK_MODES];
}

export function isManagedOpencodeModeId(value: string): boolean {
  return OPENCODE_MANAGED_MODE_IDS.has(value);
}

export function getManagedOpencodeModes(modes: OpencodeMode[]): OpencodeMode[] {
  const effectiveModes = getEffectiveOpencodeModes(modes);
  return OPENCODE_FALLBACK_MODES.map((fallbackMode) => (
    effectiveModes.find((mode) => mode.id === fallbackMode.id) ?? fallbackMode
  ));
}

export function getOpencodeToolbarModes(modes: OpencodeMode[]): OpencodeMode[] {
  return getManagedOpencodeModes(modes);
}

export function normalizeOpencodeSelectedMode(
  value: unknown,
): string {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed;
}

export function normalizeManagedOpencodeSelectedMode(
  value: unknown,
  modes: OpencodeMode[] = [],
): string {
  const normalized = normalizeOpencodeSelectedMode(value);
  if (!normalized) {
    return '';
  }

  const managedModes = getManagedOpencodeModes(modes);
  return managedModes.some((mode) => mode.id === normalized)
    ? normalized
    : (managedModes[0]?.id ?? '');
}
