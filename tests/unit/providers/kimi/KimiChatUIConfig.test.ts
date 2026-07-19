import { KIMI_SYNTHETIC_MODEL_ID } from '@/providers/kimi/models';
import { kimiChatUIConfig } from '@/providers/kimi/ui/KimiChatUIConfig';

describe('kimiChatUIConfig', () => {
  it('exposes synthetic model before discovery and owns kimi ids', () => {
    const options = kimiChatUIConfig.getModelOptions({});
    expect(options.some((option) => option.value === KIMI_SYNTHETIC_MODEL_ID)).toBe(true);
    expect(kimiChatUIConfig.ownsModel('kimi:kimi-code/k3', {})).toBe(true);
    expect(kimiChatUIConfig.ownsModel('gpt-5', {})).toBe(false);
    expect(kimiChatUIConfig.getProviderIcon?.()).toBeTruthy();
  });
});
