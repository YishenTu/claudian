import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { ANTIGRAVITY_PROVIDER_ICON } from '../../../shared/icons';
import { antigravityModelPolicy } from '../AntigravityModelPolicy';
import { getAntigravityPermissionModeOptions } from '../permissionModes';

export const antigravityChatUIConfig: ProviderChatUIConfig = {
  ...antigravityModelPolicy,
  getPermissionModeOptions: getAntigravityPermissionModeOptions,
  getProviderIcon() {
    return ANTIGRAVITY_PROVIDER_ICON;
  },
};
