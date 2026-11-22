import {
  buildPermissionModeOptions,
  createPermissionModePolicy,
  type ProviderPermissionModeDefinition,
} from '../../core/providers/permissionModes';
import type { ProviderPermissionModeOption } from '../../core/providers/types';

const CODEX_PERMISSION_MODES: readonly ProviderPermissionModeDefinition[] = Object.freeze([
  { value: 'auto-review', label: 'Approve for me', description: { key: 'chat.permissionMode.codex.autoReviewDesc' } },
  { value: 'normal', label: 'Ask for approval', description: { key: 'chat.permissionMode.codex.normalDesc' } },
  {
    value: 'yolo',
    label: 'Full access',
    description: { key: 'chat.permissionMode.codex.yoloDesc' },
    bypassesApprovals: true,
  },
]);

export const CODEX_PERMISSION_MODE_POLICY = createPermissionModePolicy(CODEX_PERMISSION_MODES, {
  fallbackValue: 'normal',
  defaultValue: 'auto-review',
});

export function getCodexPermissionModeOptions(): ProviderPermissionModeOption[] {
  return buildPermissionModeOptions(CODEX_PERMISSION_MODES);
}
