import type { ProviderPermissionModePolicy } from '../../core/providers/types';

export const ANTIGRAVITY_PERMISSION_MODES = ['normal', 'acceptEdits', 'auto', 'yolo'] as const;

export const ANTIGRAVITY_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: ANTIGRAVITY_PERMISSION_MODES,
  fallbackValue: 'normal',
  defaultValue: 'normal',
});

/**
 * agy's native `mode` option for a Claudian permission mode. Native `plan` is never selected.
 * YOLO runs native `default` in a main-chat process launched with `--dangerously-skip-permissions`,
 * which overrides every mode until the process restarts; entering or leaving YOLO replaces the process.
 */
export function resolveAntigravityNativeMode(permissionMode: string | undefined): 'accept-edits' | 'auto' | 'default' {
  if (permissionMode === 'auto') return 'auto';
  return permissionMode === 'acceptEdits' ? 'accept-edits' : 'default';
}

export function shouldAutoApproveAntigravityPermission(permissionMode: string | undefined): boolean {
  return permissionMode === 'yolo';
}
