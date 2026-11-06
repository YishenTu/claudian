import { t } from '@/i18n/i18n';

import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { ANTIGRAVITY_PROVIDER_ICON } from '../../../shared/icons';
import { antigravityModelPolicy } from '../AntigravityModelPolicy';

export const antigravityChatUIConfig: ProviderChatUIConfig = {
  ...antigravityModelPolicy,
  getPermissionModeOptions() {
    return Object.freeze([
      {
        value: 'normal',
        label: t('chat.permissionMode.antigravity.normal'),
        description: t('chat.permissionMode.antigravity.normalDesc'),
      },
      {
        value: 'acceptEdits',
        label: t('chat.permissionMode.antigravity.acceptEdits'),
        description: t('chat.permissionMode.antigravity.acceptEditsDesc'),
      },
      {
        value: 'yolo',
        label: t('chat.permissionMode.antigravity.yolo'),
        description: t('chat.permissionMode.antigravity.yoloDesc'),
        bypassesApprovals: true,
      },
    ]);
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return ANTIGRAVITY_PROVIDER_ICON;
  },
};
