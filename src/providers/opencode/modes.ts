export interface OpencodeMode {
  description?: string;
  id: string;
  name: string;
}

export const OPENCODE_BUILD_MODE_ID = 'build';
export const OPENCODE_YOLO_MODE_ID = 'claudian-yolo';
export const OPENCODE_SAFE_MODE_ID = 'claudian-safe';
export const OPENCODE_PLAN_MODE_ID = 'plan';

export const OPENCODE_FALLBACK_MODES: ReadonlyArray<OpencodeMode> = Object.freeze([
  {
    description: 'The default agent. Executes tools based on configured permissions.',
    id: OPENCODE_YOLO_MODE_ID,
    name: 'yolo',
  },
  {
    description: 'Safe mode. Asks before shell commands and file edits.',
    id: OPENCODE_SAFE_MODE_ID,
    name: 'safe',
  },
  {
    description: 'Plan mode. Disallows all edit tools.',
    id: OPENCODE_PLAN_MODE_ID,
    name: OPENCODE_PLAN_MODE_ID,
  },
]);

const OPENCODE_MANAGED_MODE_IDS = new Set([
  OPENCODE_BUILD_MODE_ID,
  ...OPENCODE_FALLBACK_MODES.map((mode) => mode.id),
]);

export function normalizeOpencodeAvailableModes(value: unknown): OpencodeMode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: OpencodeMode[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : id;
    const description = typeof record.description === 'string'
      ? record.description.trim()
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

  const canonicalModeId = normalized === OPENCODE_BUILD_MODE_ID
    ? OPENCODE_YOLO_MODE_ID
    : normalized;
  const managedModes = getManagedOpencodeModes(modes);
  return managedModes.some((mode) => mode.id === canonicalModeId)
    ? canonicalModeId
    : (managedModes[0]?.id ?? '');
}

export function resolveOpencodeModeForPermissionMode(
  permissionMode: unknown,
  modes: OpencodeMode[] = [],
): string {
  const managedModes = getManagedOpencodeModes(modes);
  const managedModeIds = new Set(managedModes.map((mode) => mode.id));

  if (permissionMode === 'plan' && managedModeIds.has(OPENCODE_PLAN_MODE_ID)) {
    return OPENCODE_PLAN_MODE_ID;
  }
  if (permissionMode === 'normal' && managedModeIds.has(OPENCODE_SAFE_MODE_ID)) {
    return OPENCODE_SAFE_MODE_ID;
  }
  if (managedModeIds.has(OPENCODE_YOLO_MODE_ID)) {
    return OPENCODE_YOLO_MODE_ID;
  }

  return managedModes[0]?.id ?? '';
}

export function resolvePermissionModeForManagedOpencodeMode(
  modeId: unknown,
): 'normal' | 'plan' | 'yolo' | null {
  if (modeId === OPENCODE_BUILD_MODE_ID || modeId === OPENCODE_YOLO_MODE_ID) {
    return 'yolo';
  }
  if (modeId === OPENCODE_SAFE_MODE_ID) {
    return 'normal';
  }
  if (modeId === OPENCODE_PLAN_MODE_ID) {
    return 'plan';
  }
  return null;
}
