import '@/providers';

import { kimiProviderRegistration } from '@/providers/kimi/registration';
import { DEFAULT_KIMI_PROVIDER_SETTINGS } from '@/providers/kimi/settings';
import { piProviderRegistration } from '@/providers/pi/registration';

describe('kimiProviderRegistration', () => {
  it('registers as disabled optional provider after current providers', () => {
    expect(kimiProviderRegistration.id).toBe('kimi');
    expect(kimiProviderRegistration.displayName).toBe('Kimi Code');
    expect(DEFAULT_KIMI_PROVIDER_SETTINGS.enabled).toBe(false);
    expect(kimiProviderRegistration.blankTabOrder).toBeGreaterThan(piProviderRegistration.blankTabOrder);
    expect(kimiProviderRegistration.isEnabled({
      providerConfigs: { kimi: { enabled: false } },
    })).toBe(false);
    expect(kimiProviderRegistration.capabilities.supportsPersistentRuntime).toBe(true);
    expect(kimiProviderRegistration.capabilities.supportsMcpTools).toBe(false);
    expect(kimiProviderRegistration.capabilities.supportsRewind).toBe(false);
  });
});
