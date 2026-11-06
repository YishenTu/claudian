import type { ProviderChatUIConfig } from '@/core/providers/types';
import { t } from '@/i18n/i18n';
import { DEEPSEEK_PROVIDER_ICON } from '@/shared/icons';

import { deepseekModelPolicy } from '../DeepSeekModelPolicy';

export const deepseekChatUIConfig: ProviderChatUIConfig = {
  ...deepseekModelPolicy,
  getPermissionModeOptions() {
    return Object.freeze([
      {
        value: 'normal',
        label: t('chat.permissionMode.deepseek.normal'),
        description: t('chat.permissionMode.deepseek.normalDesc'),
      },
      {
        value: 'yolo',
        label: t('chat.permissionMode.deepseek.yolo'),
        description: t('chat.permissionMode.deepseek.yoloDesc'),
        bypassesApprovals: true,
      },
    ]);
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return DEEPSEEK_PROVIDER_ICON;
  },
};
