import { SAFE_YOLO_PERMISSION_MODE_OPTIONS } from '../../../core/providers/permissionModes';
import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OPENAI_PROVIDER_ICON } from '../../../shared/icons';
import { codexModelPolicy } from '../CodexModelPolicy';

export const codexChatUIConfig: ProviderChatUIConfig = {
  ...codexModelPolicy,
  getPermissionModeOptions() {
    return SAFE_YOLO_PERMISSION_MODE_OPTIONS;
  },
  getServiceTierToggle: settings => codexModelPolicy.getServiceTierPolicy?.(settings) ?? null,
  getProviderIcon() {
    return OPENAI_PROVIDER_ICON;
  },
};
