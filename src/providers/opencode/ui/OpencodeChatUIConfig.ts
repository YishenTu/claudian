import { SAFE_YOLO_PERMISSION_MODE_OPTIONS } from '../../../core/providers/permissionModes';
import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '../../../shared/icons';
import { opencodeModelPolicy } from '../OpencodeModelPolicy';

export const opencodeChatUIConfig: ProviderChatUIConfig = {
  ...opencodeModelPolicy,
  getPermissionModeOptions() {
    return SAFE_YOLO_PERMISSION_MODE_OPTIONS;
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return OPENCODE_PROVIDER_ICON;
  },
};
