import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { CLAUDE_PROVIDER_ICON } from '../../../shared/icons';
import { claudeModelPolicy } from '../ClaudeModelPolicy';

export const claudeChatUIConfig: ProviderChatUIConfig = {
  ...claudeModelPolicy,
  getModelOptions: settings => claudeModelPolicy.getModelOptions(settings).slice().reverse(),
  getPermissionModeToggle() {
    return { ...claudeModelPolicy.permissionModes!, inactiveLabel: 'Safe', activeLabel: 'YOLO' };
  },
  getProviderIcon() {
    return CLAUDE_PROVIDER_ICON;
  },
};
