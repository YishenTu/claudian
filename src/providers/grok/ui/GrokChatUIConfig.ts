import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { GROK_PROVIDER_ICON } from '../../../shared/icons';
import { grokModelPolicy } from '../GrokModelPolicy';

export const grokChatUIConfig: ProviderChatUIConfig = {
  ...grokModelPolicy,
  getModelOptions: settings => grokModelPolicy.getModelOptions(settings).slice().reverse(),
  getPermissionModeToggle() {
    return { ...grokModelPolicy.permissionModes!, inactiveLabel: 'Safe', activeLabel: 'YOLO' };
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return GROK_PROVIDER_ICON;
  },
};
