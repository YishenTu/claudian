import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { GROK_PROVIDER_ICON } from '../../../shared/icons';
import { grokModelPolicy } from '../GrokModelPolicy';
import { getGrokPermissionModeOptions } from '../permissionModes';

export const grokChatUIConfig: ProviderChatUIConfig = {
  ...grokModelPolicy,
  getPermissionModeOptions: getGrokPermissionModeOptions,
  getProviderIcon() {
    return GROK_PROVIDER_ICON;
  },
};
