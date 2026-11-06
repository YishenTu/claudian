import { t } from '@/i18n/i18n';

import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '../../../shared/icons';
import { maybeGetOpencodeWorkspaceServices } from '../app/OpencodeWorkspaceServices';
import { createOpencodeModelMetadataPreparer, opencodeModelPolicy } from '../OpencodeModelPolicy';

export const opencodeChatUIConfig: ProviderChatUIConfig = {
  ...opencodeModelPolicy,
  prepareModelMetadata: createOpencodeModelMetadataPreparer(
    () => maybeGetOpencodeWorkspaceServices()?.metadataService,
  ),
  getPermissionModeOptions() {
    return Object.freeze([
      {
        value: 'normal',
        label: t('chat.permissionMode.opencode.normal'),
        description: t('chat.permissionMode.opencode.normalDesc'),
      },
      {
        value: 'yolo',
        label: t('chat.permissionMode.opencode.yolo'),
        description: t('chat.permissionMode.opencode.yoloDesc'),
        bypassesApprovals: true,
      },
    ]);
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return OPENCODE_PROVIDER_ICON;
  },
};
