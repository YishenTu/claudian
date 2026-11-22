import { t } from '@/i18n/i18n';

import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OPENAI_PROVIDER_ICON } from '../../../shared/icons';
import { codexModelPolicy } from '../CodexModelPolicy';
import { stripCodexFileCitations } from '../normalization/CodexFileCitation';
import { getCodexPermissionModeOptions } from '../permissionModes';
import { getCodexProviderSettings } from '../settings';

export const codexChatUIConfig: ProviderChatUIConfig = {
  ...codexModelPolicy,
  prepareAssistantMarkdown: stripCodexFileCitations,
  getPermissionModeOptions(settings = {}) {
    const readOnly = getCodexProviderSettings(settings).safeMode === 'read-only';
    return getCodexPermissionModeOptions().map(option => (
      readOnly && option.value === 'normal'
        ? { ...option, description: t('chat.permissionMode.codex.readOnlyDesc') }
        : option
    ));
  },
  getServiceTierToggle: settings => codexModelPolicy.getServiceTierPolicy?.(settings) ?? null,
  getProviderIcon() {
    return OPENAI_PROVIDER_ICON;
  },
};
