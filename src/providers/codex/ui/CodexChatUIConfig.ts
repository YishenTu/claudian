import { t } from '@/i18n/i18n';

import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OPENAI_PROVIDER_ICON } from '../../../shared/icons';
import { codexModelPolicy } from '../CodexModelPolicy';
import { getCodexProviderSettings } from '../settings';

export const codexChatUIConfig: ProviderChatUIConfig = {
  ...codexModelPolicy,
  getPermissionModeOptions(settings = {}) {
    const readOnly = getCodexProviderSettings(settings).safeMode === 'read-only';
    return [
      {
        value: 'auto-review', label: t('chat.permissionMode.codex.autoReview'),
        description: t('chat.permissionMode.codex.autoReviewDesc'),
      },
      {
        value: 'normal', label: t('chat.permissionMode.codex.normal'),
        description: readOnly
          ? t('chat.permissionMode.codex.readOnlyDesc')
          : t('chat.permissionMode.codex.normalDesc'),
      },
      {
        value: 'yolo', label: t('chat.permissionMode.codex.yolo'), bypassesApprovals: true,
        description: t('chat.permissionMode.codex.yoloDesc'),
      },
    ];
  },
  getServiceTierToggle: settings => codexModelPolicy.getServiceTierPolicy?.(settings) ?? null,
  getProviderIcon() {
    return OPENAI_PROVIDER_ICON;
  },
};
