import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { PI_PROVIDER_ICON } from '../../../shared/icons';
import { piModelPolicy } from '../PiModelPolicy';

export const piChatUIConfig: ProviderChatUIConfig = {
  ...piModelPolicy,
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return PI_PROVIDER_ICON;
  },
};
