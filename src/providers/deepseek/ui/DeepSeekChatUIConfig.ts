import type { ProviderChatUIConfig } from '@/core/providers/types';
import { DEEPSEEK_PROVIDER_ICON } from '@/shared/icons';

import { deepseekModelPolicy } from '../DeepSeekModelPolicy';
import { DEEPSEEK_PERMISSION_MODE_OPTIONS } from '../permissionModes';

export const deepseekChatUIConfig: ProviderChatUIConfig = {
  ...deepseekModelPolicy,
  getPermissionModeOptions() {
    return DEEPSEEK_PERMISSION_MODE_OPTIONS;
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return DEEPSEEK_PROVIDER_ICON;
  },
};
