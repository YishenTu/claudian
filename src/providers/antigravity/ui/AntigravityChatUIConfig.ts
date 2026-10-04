import type { ProviderChatUIConfig } from '@/core/providers/types';
import { ANTIGRAVITY_PROVIDER_ICON } from '@/shared/icons';

import { antigravityModelPolicy } from '../AntigravityModelPolicy';
import { ANTIGRAVITY_PERMISSION_MODE_OPTIONS } from '../permissionModes';

export const antigravityChatUIConfig: ProviderChatUIConfig = {
  ...antigravityModelPolicy,
  getPermissionModeOptions() {
    return ANTIGRAVITY_PERMISSION_MODE_OPTIONS;
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return ANTIGRAVITY_PROVIDER_ICON;
  },
};
