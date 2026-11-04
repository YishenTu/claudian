import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
} from '../../core/providers/types';

export const ANTIGRAVITY_PERMISSION_MODES = ['normal', 'acceptEdits', 'yolo'] as const;

export const ANTIGRAVITY_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: ANTIGRAVITY_PERMISSION_MODES,
  fallbackValue: 'normal',
  defaultValue: 'normal',
});

export const ANTIGRAVITY_PERMISSION_MODE_OPTIONS: readonly ProviderPermissionModeOption[] = Object.freeze([
  { value: 'normal', label: 'Ask', description: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Approve file edits in the workspace without asking' },
  {
    value: 'yolo',
    label: 'YOLO',
    description: 'Accept all permissions without asking',
    bypassesApprovals: true,
  },
]);

/**
 * agy's native `mode` option for a Claudian permission mode. Native `plan` is never selected.
 * YOLO runs native `default`: `--dangerously-skip-permissions` would override every mode for the
 * process lifetime, so Claudian approves YOLO prompts itself and modes switch without restarts.
 */
export function resolveAntigravityNativeMode(permissionMode: string | undefined): 'accept-edits' | 'default' {
  return permissionMode === 'acceptEdits' ? 'accept-edits' : 'default';
}

export function shouldAutoApproveAntigravityPermission(permissionMode: string | undefined): boolean {
  return permissionMode === 'yolo';
}
