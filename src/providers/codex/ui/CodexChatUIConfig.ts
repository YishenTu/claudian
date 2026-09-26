import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OPENAI_PROVIDER_ICON } from '../../../shared/icons';
import { codexModelPolicy } from '../CodexModelPolicy';

export const codexChatUIConfig: ProviderChatUIConfig = {
  ...codexModelPolicy,
  getModelOptions: settings => codexModelPolicy.getModelOptions(settings).slice().reverse(),
  getPermissionModeToggle() {
    return { ...codexModelPolicy.permissionModes!, inactiveLabel: 'Safe', activeLabel: 'YOLO' };
  },
  getServiceTierToggle: settings => codexModelPolicy.getServiceTierPolicy?.(settings) ?? null,
  getProviderIcon() {
    return OPENAI_PROVIDER_ICON;
  },
};
