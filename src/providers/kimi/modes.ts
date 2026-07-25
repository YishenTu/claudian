// Kimi ACP advertises a locked 4-mode taxonomy via the `mode` config select
// (default / plan / auto / yolo). Mode is session-scoped and resets to
// `default` on every session/new and session/load.
export const KIMI_DEFAULT_MODE_ID = 'default';
export const KIMI_PLAN_MODE_ID = 'plan';
export const KIMI_YOLO_MODE_ID = 'yolo';

export function resolveKimiModeForPermissionMode(permissionMode: unknown): string {
  if (permissionMode === 'plan') {
    return KIMI_PLAN_MODE_ID;
  }
  if (permissionMode === 'yolo') {
    return KIMI_YOLO_MODE_ID;
  }
  return KIMI_DEFAULT_MODE_ID;
}

// `auto` has no shared permission-mode equivalent; leave the toggle untouched for it.
export function resolvePermissionModeForKimiMode(
  modeId: unknown,
): 'normal' | 'plan' | 'yolo' | null {
  if (modeId === KIMI_PLAN_MODE_ID) {
    return 'plan';
  }
  if (modeId === KIMI_YOLO_MODE_ID) {
    return 'yolo';
  }
  if (modeId === KIMI_DEFAULT_MODE_ID) {
    return 'normal';
  }
  return null;
}
