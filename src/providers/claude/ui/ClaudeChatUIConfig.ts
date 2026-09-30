import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { CLAUDE_PROVIDER_ICON } from '../../../shared/icons';
import { claudeModelPolicy } from '../ClaudeModelPolicy';
import { CLAUDE_PERMISSION_MODE_OPTIONS } from '../permissionModes';

export const claudeChatUIConfig: ProviderChatUIConfig = {
  ...claudeModelPolicy,
  getPermissionModeOptions() {
    return CLAUDE_PERMISSION_MODE_OPTIONS;
  },
  getProviderIcon() {
    return CLAUDE_PROVIDER_ICON;
  },
};
