import type { ProviderChatUIConfig } from '@/core/providers/types';
import { DEEPSEEK_PROVIDER_ICON } from '@/shared/icons';

import { deepseekModelPolicy } from '../DeepSeekModelPolicy';
import { getDeepSeekPermissionModeOptions } from '../permissionModes';

export const deepseekChatUIConfig: ProviderChatUIConfig = {
  ...deepseekModelPolicy,
  getPermissionModeOptions: getDeepSeekPermissionModeOptions,
  getProviderIcon() {
    return DEEPSEEK_PROVIDER_ICON;
  },
};
