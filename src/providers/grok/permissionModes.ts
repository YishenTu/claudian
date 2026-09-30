import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
} from '../../core/providers/types';

/** Stored values; `normal` (ask) and `yolo` (always-approve) predate the full native set. */
export const GROK_PERMISSION_MODES = ['auto', 'normal', 'acceptEdits', 'yolo'] as const;
export type GrokPermissionMode = typeof GROK_PERMISSION_MODES[number];

export const GROK_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: GROK_PERMISSION_MODES,
  fallbackValue: 'normal',
  defaultValue: 'auto',
});

export const GROK_PERMISSION_MODE_OPTIONS: readonly ProviderPermissionModeOption[] = Object.freeze([
  { value: 'auto', label: 'Auto', description: 'Grok reviews actions and blocks risky ones' },
  { value: 'normal', label: 'Ask', description: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Automatically accept file edits' },
  {
    value: 'yolo',
    label: 'YOLO',
    description: 'Accept all permissions without asking',
    bypassesApprovals: true,
  },
]);

/**
 * ACP session metadata reaches only Grok's auto and always-approve modes, so
 * accept-edits approves native `default` edit prompts the way Grok's own mode would.
 */
export function shouldAutoApproveGrokPermission(
  permissionMode: string | undefined,
  toolKind: string | null | undefined,
): boolean {
  return permissionMode === 'acceptEdits' && toolKind === 'edit';
}
