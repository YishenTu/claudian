import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OPENCODE_PROVIDER_ICON } from '../../../shared/icons';
import { maybeGetOpencodeWorkspaceServices } from '../app/OpencodeWorkspaceServices';
import { createOpencodeModelMetadataPreparer, opencodeModelPolicy } from '../OpencodeModelPolicy';
import { getOpencodePermissionModeOptions } from '../permissionModes';

export const opencodeChatUIConfig: ProviderChatUIConfig = {
  ...opencodeModelPolicy,
  prepareModelMetadata: createOpencodeModelMetadataPreparer(
    () => maybeGetOpencodeWorkspaceServices()?.metadataService,
  ),
  getPermissionModeOptions: getOpencodePermissionModeOptions,
  getProviderIcon() {
    return OPENCODE_PROVIDER_ICON;
  },
};
