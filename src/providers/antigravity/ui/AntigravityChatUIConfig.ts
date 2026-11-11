import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { ANTIGRAVITY_PROVIDER_ICON } from '../../../shared/icons';
import { antigravityModelPolicy } from '../AntigravityModelPolicy';

export const antigravityChatUIConfig: ProviderChatUIConfig = {
  ...antigravityModelPolicy,
  getPermissionModeOptions() {
    return [
      { value: 'normal', label: 'Ask', description: 'Ask before edits and commands' },
      { value: 'acceptEdits', label: 'Accept edits', description: 'Approve file edits in the workspace without asking' },
      { value: 'auto', label: t('chat.permissionMode.antigravity.auto'), description: t('chat.permissionMode.antigravity.autoDesc') },
      {
        value: 'yolo',
        label: 'YOLO',
        description: 'Accept all permissions without asking',
        bypassesApprovals: true,
      },
    ];
  },
  getProviderIcon() {
    return ANTIGRAVITY_PROVIDER_ICON;
  },
};
