import { SAFE_YOLO_PERMISSION_MODE_OPTIONS } from '../../../core/providers/permissionModes';
import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { GROK_PROVIDER_ICON } from '../../../shared/icons';
import { grokModelPolicy } from '../GrokModelPolicy';

export const grokChatUIConfig: ProviderChatUIConfig = {
  ...grokModelPolicy,
  getPermissionModeOptions() {
    return SAFE_YOLO_PERMISSION_MODE_OPTIONS;
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return GROK_PROVIDER_ICON;
  },
};
