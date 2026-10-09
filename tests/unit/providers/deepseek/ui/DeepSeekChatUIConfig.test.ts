import { DEEPSEEK_PERMISSION_MODE_OPTIONS } from '@/providers/deepseek/permissionModes';
import { deepseekProviderRegistration } from '@/providers/deepseek/registration';
import { deepseekChatUIConfig } from '@/providers/deepseek/ui/DeepSeekChatUIConfig';
import { DEEPSEEK_PROVIDER_ICON } from '@/shared/icons';

describe('DeepSeekChatUIConfig', () => {
  it('brands DeepSeek chat with its whale icon and offers its permission modes', () => {
    expect(deepseekProviderRegistration.chatUIConfig).toBe(deepseekChatUIConfig);
    expect(deepseekChatUIConfig.getProviderIcon?.()).toBe(DEEPSEEK_PROVIDER_ICON);
    expect(deepseekChatUIConfig.getPermissionModeOptions?.({})).toBe(DEEPSEEK_PERMISSION_MODE_OPTIONS);
    expect(DEEPSEEK_PERMISSION_MODE_OPTIONS.map(({ label, description }) => ({ label, description }))).toEqual([
      { label: 'Workspace write', description: 'Ask before extra access.' },
      { label: 'Full access', description: 'Unrestricted files and internet.' },
    ]);
    expect(deepseekChatUIConfig.getModeSelector?.({})).toBeNull();
  });
});
