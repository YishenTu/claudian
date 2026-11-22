import {
  buildPermissionModeOptions,
  createPermissionModePolicy,
  type ProviderPermissionModeDefinition,
} from '@/core/providers/permissionModes';
import type { ProviderPermissionModeOption } from '@/core/providers/types';

const DEEPSEEK_PERMISSION_MODES: readonly ProviderPermissionModeDefinition[] = Object.freeze([
  { value: 'normal', label: 'Workspace write', description: 'Ask before extra access.' },
  {
    value: 'yolo',
    label: 'Full access',
    description: 'Unrestricted files and internet.',
    bypassesApprovals: true,
  },
]);

export const DEEPSEEK_PERMISSION_MODE_POLICY = createPermissionModePolicy(DEEPSEEK_PERMISSION_MODES, {
  defaultValue: 'normal',
  fallbackValue: 'normal',
});

export function getDeepSeekPermissionModeOptions(): ProviderPermissionModeOption[] {
  return buildPermissionModeOptions(DEEPSEEK_PERMISSION_MODES);
}
