import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '../../../shared/icons';
import { opencodeModelPolicy } from '../OpencodeModelPolicy';
import { OPENCODE_PERMISSION_MODE_OPTIONS } from '../permissionModes';

export const opencodeChatUIConfig: ProviderChatUIConfig = {
  ...opencodeModelPolicy,
  getPermissionModeOptions() {
    return OPENCODE_PERMISSION_MODE_OPTIONS;
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return OPENCODE_PROVIDER_ICON;
  },
};
