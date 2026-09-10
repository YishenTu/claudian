import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OMP_PROVIDER_ICON } from '../../../shared/icons';
import { definePiFamilyChatUIConfig } from '../../pi-rpc/ui/PiFamilyChatUIConfig';
import { ompFamilyProfile } from '../profile';

export const ompChatUIConfig: ProviderChatUIConfig = definePiFamilyChatUIConfig(ompFamilyProfile, {
  icon: OMP_PROVIDER_ICON,
});
