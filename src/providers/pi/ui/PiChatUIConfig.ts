import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { PI_PROVIDER_ICON } from '../../../shared/icons';
import { definePiFamilyChatUIConfig } from '../../pi-rpc/ui/PiFamilyChatUIConfig';
import { piFamilyProfile } from '../profile';

export const piChatUIConfig: ProviderChatUIConfig = definePiFamilyChatUIConfig(piFamilyProfile, {
  icon: PI_PROVIDER_ICON,
});