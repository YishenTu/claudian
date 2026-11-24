import {
  buildPermissionModeOptions,
  createPermissionModePolicy,
  type ProviderPermissionModeDefinition,
} from '../../core/providers/permissionModes';
import type { ProviderPermissionModeOption } from '../../core/providers/types';

const ANTIGRAVITY_PERMISSION_MODES: readonly ProviderPermissionModeDefinition[] = Object.freeze([
  { value: 'normal', label: 'Ask', description: 'Ask before edits and commands' },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    description: 'Approve file edits in the workspace without asking',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: { key: 'chat.permissionMode.antigravity.autoDesc' },
  },
  {
    value: 'yolo',
    label: 'YOLO',
    description: 'Accept all permissions without asking',
    bypassesApprovals: true,
  },
]);

export const ANTIGRAVITY_PERMISSION_MODE_POLICY = createPermissionModePolicy(ANTIGRAVITY_PERMISSION_MODES, {
  fallbackValue: 'normal',
  defaultValue: 'normal',
});

export function getAntigravityPermissionModeOptions(): ProviderPermissionModeOption[] {
  return buildPermissionModeOptions(ANTIGRAVITY_PERMISSION_MODES);
}

/**
 * agy's native `mode` option for a Claudian permission mode. Native `plan` is never selected.
 * YOLO runs native `default`, and Claudian approves every request agy relays, subagents' included.
 */
export function resolveAntigravityNativeMode(permissionMode: string | undefined): 'accept-edits' | 'auto' | 'default' {
  if (permissionMode === 'auto') return 'auto';
  return permissionMode === 'acceptEdits' ? 'accept-edits' : 'default';
}

export function shouldAutoApproveAntigravityPermission(permissionMode: string | undefined): boolean {
  return permissionMode === 'yolo';
}
