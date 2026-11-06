import { t } from '@/i18n/i18n';

import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { GROK_PROVIDER_ICON } from '../../../shared/icons';
import { grokModelPolicy } from '../GrokModelPolicy';

export const grokChatUIConfig: ProviderChatUIConfig = {
  ...grokModelPolicy,
  getPermissionModeOptions() {
    return Object.freeze([
      {
        value: 'auto',
        label: t('chat.permissionMode.grok.auto'),
        description: t('chat.permissionMode.grok.autoDesc'),
      },
      {
        value: 'normal',
        label: t('chat.permissionMode.grok.normal'),
        description: t('chat.permissionMode.grok.normalDesc'),
      },
      {
        value: 'acceptEdits',
        label: t('chat.permissionMode.grok.acceptEdits'),
        description: t('chat.permissionMode.grok.acceptEditsDesc'),
      },
      {
        value: 'yolo',
        label: t('chat.permissionMode.grok.yolo'),
        description: t('chat.permissionMode.grok.yoloDesc'),
        bypassesApprovals: true,
      },
    ]);
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return GROK_PROVIDER_ICON;
  },
};
