import {
  buildPermissionModeOptions,
  createPermissionModePolicy,
  type ProviderPermissionModeDefinition,
} from '../../core/providers/permissionModes';
import type { ProviderPermissionModeOption } from '../../core/providers/types';

/** Stored values in menu order; `normal` (ask) and `yolo` (always-approve) predate the full native set. */
const GROK_PERMISSION_MODES: readonly ProviderPermissionModeDefinition[] = Object.freeze([
  { value: 'auto', label: 'Auto', description: 'Grok reviews actions and blocks risky ones' },
  { value: 'normal', label: 'Ask', description: 'Ask before edits and commands' },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    description: 'Automatically accept file edits',
  },
  {
    value: 'yolo',
    label: 'YOLO',
    description: 'Accept all permissions without asking',
    bypassesApprovals: true,
  },
]);

export const GROK_PERMISSION_MODE_POLICY = createPermissionModePolicy(GROK_PERMISSION_MODES, {
  fallbackValue: 'normal',
  defaultValue: 'auto',
});

export function getGrokPermissionModeOptions(): ProviderPermissionModeOption[] {
  return buildPermissionModeOptions(GROK_PERMISSION_MODES);
}

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
