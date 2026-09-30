import { SAFE_YOLO_PERMISSION_MODE_OPTIONS } from '../../../core/providers/permissionModes';
import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { PI_PROVIDER_ICON } from '../../../shared/icons';
import { piModelPolicy } from '../PiModelPolicy';

export const piChatUIConfig: ProviderChatUIConfig = {
  ...piModelPolicy,
  getPermissionModeOptions() {
    return SAFE_YOLO_PERMISSION_MODE_OPTIONS;
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return PI_PROVIDER_ICON;
  },
};
