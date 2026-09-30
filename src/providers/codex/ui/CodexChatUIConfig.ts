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
        value: 'auto-review', label: 'Approve for me',
        description: 'Auto-review extra access.',
      },
      {
        value: 'normal', label: 'Ask for approval',
        description: readOnly
          ? 'Ask before edits or internet.'
          : 'Ask before extra access.',
      },
      {
        value: 'yolo', label: 'Full access', bypassesApprovals: true,
        description: 'Unrestricted files and internet.',
      },
    ];
  },
  getServiceTierToggle: settings => codexModelPolicy.getServiceTierPolicy?.(settings) ?? null,
  getProviderIcon() {
    return OPENAI_PROVIDER_ICON;
  },
};
