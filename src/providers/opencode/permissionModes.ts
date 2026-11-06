import type { ProviderPermissionModePolicy } from '../../core/providers/types';

/** OpenCode's native client modes: prompt for `ask` rules, or accept them (`--auto`). */
export const OPENCODE_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: Object.freeze(['normal', 'yolo']),
  fallbackValue: 'normal',
  defaultValue: 'normal',
});
