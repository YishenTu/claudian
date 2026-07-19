export interface KimiMode {
  description?: string;
  id: string;
  name: string;
}

/** Canonical Kimi ACP modes (adapter PLAN D9): default, plan, auto, yolo. */
export const KIMI_DEFAULT_MODE_ID = 'default';
export const KIMI_PLAN_MODE_ID = 'plan';
export const KIMI_AUTO_MODE_ID = 'auto';
export const KIMI_YOLO_MODE_ID = 'yolo';

export const KIMI_FALLBACK_MODES: ReadonlyArray<KimiMode> = Object.freeze([
  {
    description: 'Manual approvals; tools execute normally.',
    id: KIMI_DEFAULT_MODE_ID,
    name: 'Default',
  },
  {
    description: 'Read-only planning; no tool execution.',
    id: KIMI_PLAN_MODE_ID,
    name: 'Plan',
  },
  {
    description: 'Fully autonomous — agent decides everything without asking.',
    id: KIMI_AUTO_MODE_ID,
    name: 'Auto',
  },
  {
    description: 'Auto-approve tool actions; agent may still ask questions.',
    id: KIMI_YOLO_MODE_ID,
    name: 'YOLO',
  },
]);

const KIMI_KNOWN_MODE_IDS = new Set(KIMI_FALLBACK_MODES.map((mode) => mode.id));

export function isKimiModeId(value: unknown): value is string {
  return typeof value === 'string' && KIMI_KNOWN_MODE_IDS.has(value);
}

export function normalizeKimiAvailableModes(value: unknown): KimiMode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: KimiMode[] = [];
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

export function getEffectiveKimiModes(modes: KimiMode[]): KimiMode[] {
  return modes.length > 0 ? modes : [...KIMI_FALLBACK_MODES];
}

/**
 * Map Claudian shared permission modes onto Kimi ACP mode ids.
 * Prefer advertised modes; fall back to canonical ids only when listed.
 */
export function resolveKimiModeForPermissionMode(
  permissionMode: unknown,
  modes: KimiMode[] = [],
): string {
  const effective = getEffectiveKimiModes(modes);
  const modeIds = new Set(effective.map((mode) => mode.id));

  if (permissionMode === 'plan' && modeIds.has(KIMI_PLAN_MODE_ID)) {
    return KIMI_PLAN_MODE_ID;
  }
  if (permissionMode === 'yolo' && modeIds.has(KIMI_YOLO_MODE_ID)) {
    return KIMI_YOLO_MODE_ID;
  }
  if (modeIds.has(KIMI_DEFAULT_MODE_ID)) {
    return KIMI_DEFAULT_MODE_ID;
  }

  return effective[0]?.id ?? KIMI_DEFAULT_MODE_ID;
}

export function resolvePermissionModeForKimiMode(
  modeId: unknown,
): 'normal' | 'plan' | 'yolo' | null {
  if (modeId === KIMI_PLAN_MODE_ID) {
    return 'plan';
  }
  if (modeId === KIMI_YOLO_MODE_ID || modeId === KIMI_AUTO_MODE_ID) {
    return 'yolo';
  }
  if (modeId === KIMI_DEFAULT_MODE_ID) {
    return 'normal';
  }
  return null;
}
