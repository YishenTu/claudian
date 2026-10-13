import { t } from '@/i18n/i18n';

import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { CLAUDE_PROVIDER_ICON } from '../../../shared/icons';
import { claudeModelPolicy } from '../ClaudeModelPolicy';

export const claudeChatUIConfig: ProviderChatUIConfig = {
  ...claudeModelPolicy,
  getPermissionModeOptions() {
    return [
      { value: 'auto', label: t('chat.permissionMode.claude.auto'), description: t('chat.permissionMode.claude.autoDesc') },
      { value: 'manual', label: t('chat.permissionMode.claude.manual'), description: t('chat.permissionMode.claude.manualDesc') },
      { value: 'acceptEdits', label: t('chat.permissionMode.claude.acceptEdits'), description: t('chat.permissionMode.claude.acceptEditsDesc') },
      { value: 'yolo', label: t('chat.permissionMode.claude.yolo'), description: t('chat.permissionMode.claude.yoloDesc'), bypassesApprovals: true },
    ];
  },
  getProviderIcon() {
    return CLAUDE_PROVIDER_ICON;
  },
};
