import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
} from '../../core/providers/types';

/** OpenCode's native client modes: prompt for `ask` rules, or accept them (`--auto`). */
export const OPENCODE_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: Object.freeze(['normal', 'yolo']),
  fallbackValue: 'normal',
  defaultValue: 'normal',
});

export const OPENCODE_PERMISSION_MODE_OPTIONS: readonly ProviderPermissionModeOption[] = Object.freeze([
  { value: 'normal', label: 'Ask', description: 'Ask when OpenCode permission rules require it' },
  {
    value: 'yolo',
    label: 'YOLO',
    description: 'Accept all permissions not explicitly denied',
    bypassesApprovals: true,
  },
]);
