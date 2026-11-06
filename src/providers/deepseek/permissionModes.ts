import type { ProviderPermissionModePolicy } from '@/core/providers/types';

export const DEEPSEEK_PERMISSION_MODES = ['normal', 'yolo'] as const;

export const DEEPSEEK_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: DEEPSEEK_PERMISSION_MODES,
  defaultValue: 'normal',
  fallbackValue: 'normal',
});
