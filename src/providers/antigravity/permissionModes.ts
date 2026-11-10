import type { ProviderPermissionModePolicy } from '../../core/providers/types';

export const ANTIGRAVITY_PERMISSION_MODES = ['normal', 'acceptEdits', 'auto', 'yolo'] as const;

export const ANTIGRAVITY_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: ANTIGRAVITY_PERMISSION_MODES,
  fallbackValue: 'normal',
  defaultValue: 'normal',
});

/**
 * agy's native `mode` option for a Claudian permission mode. Native `plan` is never selected.
 * YOLO runs native `default`: `--dangerously-skip-permissions` would override every mode for the
 * process lifetime, so Claudian approves YOLO prompts itself and modes switch without restarts.
 */
export function resolveAntigravityNativeMode(permissionMode: string | undefined): 'accept-edits' | 'auto' | 'default' {
  if (permissionMode === 'auto') return 'auto';
  return permissionMode === 'acceptEdits' ? 'accept-edits' : 'default';
}

export function shouldAutoApproveAntigravityPermission(permissionMode: string | undefined): boolean {
  return permissionMode === 'yolo';
}
