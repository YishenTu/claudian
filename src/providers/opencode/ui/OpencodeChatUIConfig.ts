import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '../../../shared/icons';
import { opencodeModelPolicy } from '../OpencodeModelPolicy';

export const opencodeChatUIConfig: ProviderChatUIConfig = {
  ...opencodeModelPolicy,
  getModelOptions: settings => opencodeModelPolicy.getModelOptions(settings).slice().reverse(),
  getPermissionModeToggle() {
    return { ...opencodeModelPolicy.permissionModes!, inactiveLabel: 'Safe', activeLabel: 'YOLO' };
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return OPENCODE_PROVIDER_ICON;
  },
};
