import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
} from '@/core/providers/types';

export const ANTIGRAVITY_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: Object.freeze(['default', 'auto_edit', 'yolo']),
  fallbackValue: 'default',
  defaultValue: 'default',
});

export const ANTIGRAVITY_PERMISSION_MODE_OPTIONS: readonly ProviderPermissionModeOption[] = Object.freeze([
  {
    value: 'default',
    label: 'Default',
    description: 'Ask before running tools or writing files',
  },
  {
    value: 'auto_edit',
    label: 'Auto Edit',
    description: 'Automatically approve file edits; prompt for shell and external tools',
  },
  {
    value: 'yolo',
    label: 'YOLO',
    description: 'Auto-approve all tools without confirmation',
    bypassesApprovals: true,
  },
]);
