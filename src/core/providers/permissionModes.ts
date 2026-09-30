import type { ProviderPermissionModeOption, ProviderPermissionModePolicy } from './types';

/** Safe/YOLO policy for providers whose Safe mode is their native approval flow. */
export const SAFE_YOLO_PERMISSION_MODES: ProviderPermissionModePolicy = Object.freeze({
  values: Object.freeze(['normal', 'yolo']),
  fallbackValue: 'normal',
});

export const SAFE_YOLO_PERMISSION_MODE_OPTIONS: readonly ProviderPermissionModeOption[] = Object.freeze([
  { value: 'normal', label: 'SAFE' },
  { value: 'yolo', label: 'YOLO', bypassesApprovals: true },
]);
