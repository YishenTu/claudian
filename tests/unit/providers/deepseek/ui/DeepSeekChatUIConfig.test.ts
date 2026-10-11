import '@/providers';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { DEEPSEEK_PROVIDER_ICON } from '@/shared/icons';

describe('DeepSeekChatUIConfig', () => {
  it('offers exactly the saved permission modes, with only native full access bypassing approvals', () => {
    const ui = ProviderRegistry.getChatUIConfig('deepseek');
    const policy = ProviderRegistry.getModelPolicy('deepseek').permissionModes!;
    const options = ui.getPermissionModeOptions?.({}) ?? [];

    expect(options.map(option => option.value)).toEqual([...policy.values]);
    expect(new Set(options.map(option => option.label)).size).toBe(options.length);
    // `yolo` is the mode execution applies as native danger-full-access.
    expect(options.filter(option => option.bypassesApprovals).map(option => option.value)).toEqual(['yolo']);
    for (const safe of [policy.defaultValue, policy.fallbackValue]) {
      const option = options.find(candidate => candidate.value === safe);
      expect(option).toBeDefined();
      expect(option!.bypassesApprovals).toBeFalsy();
    }
    expect(ui.getModeSelector?.({})).toBeNull();
    expect(ui.getProviderIcon?.()).toBe(DEEPSEEK_PROVIDER_ICON);
  });
});
