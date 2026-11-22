import {
  buildPermissionModeOptions,
  createPermissionModePolicy,
  type ProviderPermissionModeDefinition,
} from '../../core/providers/permissionModes';
import type { ProviderPermissionModeOption } from '../../core/providers/types';

/** OpenCode's native client modes: prompt for `ask` rules, or accept them (`--auto`). */
const OPENCODE_PERMISSION_MODES: readonly ProviderPermissionModeDefinition[] = Object.freeze([
  { value: 'normal', label: 'Ask', description: 'Ask when OpenCode permission rules require it' },
  {
    value: 'yolo',
    label: 'YOLO',
    description: 'Accept all permissions not explicitly denied',
    bypassesApprovals: true,
  },
]);

export const OPENCODE_PERMISSION_MODE_POLICY = createPermissionModePolicy(OPENCODE_PERMISSION_MODES, {
  fallbackValue: 'normal',
  defaultValue: 'normal',
});

export function getOpencodePermissionModeOptions(): ProviderPermissionModeOption[] {
  return buildPermissionModeOptions(OPENCODE_PERMISSION_MODES);
}
