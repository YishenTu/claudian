import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { GROK_PROVIDER_ICON } from '../../../shared/icons';
import { grokModelPolicy } from '../GrokModelPolicy';
import { GROK_PERMISSION_MODE_OPTIONS } from '../permissionModes';

export const grokChatUIConfig: ProviderChatUIConfig = {
  ...grokModelPolicy,
  getPermissionModeOptions() {
    return GROK_PERMISSION_MODE_OPTIONS;
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return GROK_PROVIDER_ICON;
  },
};
