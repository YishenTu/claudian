export interface GeminiMode {
  description?: string;
  id: string;
  name: string;
}

export const GEMINI_BUILD_MODE_ID = 'build';
export const GEMINI_YOLO_MODE_ID = 'claudian-yolo';
export const GEMINI_SAFE_MODE_ID = 'claudian-safe';
export const GEMINI_PLAN_MODE_ID = 'plan';

export const GEMINI_FALLBACK_MODES: ReadonlyArray<GeminiMode> = Object.freeze([
  {
    description: 'The default agent. Executes tools based on configured permissions.',
    id: GEMINI_YOLO_MODE_ID,
    name: 'yolo',
  },
  {
    description: 'Safe mode. Asks before shell commands and file edits.',
    id: GEMINI_SAFE_MODE_ID,
    name: 'safe',
  },
  {
    description: 'Plan mode. Disallows all edit tools.',
    id: GEMINI_PLAN_MODE_ID,
    name: GEMINI_PLAN_MODE_ID,
  },
]);

const GEMINI_MANAGED_MODE_IDS = new Set([
  GEMINI_BUILD_MODE_ID,
  ...GEMINI_FALLBACK_MODES.map((mode) => mode.id),
]);

export function normalizeGeminiAvailableModes(value: unknown): GeminiMode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: GeminiMode[] = [];
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

export function getEffectiveGeminiModes(modes: GeminiMode[]): GeminiMode[] {
  return modes.length > 0 ? modes : [...GEMINI_FALLBACK_MODES];
}

export function isManagedGeminiModeId(value: string): boolean {
  return GEMINI_MANAGED_MODE_IDS.has(value);
}

export function getManagedGeminiModes(modes: GeminiMode[]): GeminiMode[] {
  const effectiveModes = getEffectiveGeminiModes(modes);
  return GEMINI_FALLBACK_MODES.map((fallbackMode) => (
    effectiveModes.find((mode) => mode.id === fallbackMode.id) ?? fallbackMode
  ));
}

export function normalizeGeminiSelectedMode(
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

export function normalizeManagedGeminiSelectedMode(
  value: unknown,
  modes: GeminiMode[] = [],
): string {
  const normalized = normalizeGeminiSelectedMode(value);
  if (!normalized) {
    return '';
  }

  const canonicalModeId = normalized === GEMINI_BUILD_MODE_ID
    ? GEMINI_YOLO_MODE_ID
    : normalized;
  const managedModes = getManagedGeminiModes(modes);
  return managedModes.some((mode) => mode.id === canonicalModeId)
    ? canonicalModeId
    : (managedModes[0]?.id ?? '');
}

export function resolveGeminiModeForPermissionMode(
  permissionMode: unknown,
  modes: GeminiMode[] = [],
): string {
  const managedModes = getManagedGeminiModes(modes);
  const managedModeIds = new Set(managedModes.map((mode) => mode.id));

  if (permissionMode === 'plan' && managedModeIds.has(GEMINI_PLAN_MODE_ID)) {
    return GEMINI_PLAN_MODE_ID;
  }
  if (permissionMode === 'normal' && managedModeIds.has(GEMINI_SAFE_MODE_ID)) {
    return GEMINI_SAFE_MODE_ID;
  }
  if (managedModeIds.has(GEMINI_YOLO_MODE_ID)) {
    return GEMINI_YOLO_MODE_ID;
  }

  return managedModes[0]?.id ?? '';
}

export function resolvePermissionModeForManagedGeminiMode(
  modeId: unknown,
): 'normal' | 'plan' | 'yolo' | null {
  if (modeId === GEMINI_BUILD_MODE_ID || modeId === GEMINI_YOLO_MODE_ID) {
    return 'yolo';
  }
  if (modeId === GEMINI_SAFE_MODE_ID) {
    return 'normal';
  }
  if (modeId === GEMINI_PLAN_MODE_ID) {
    return 'plan';
  }
  return null;
}
