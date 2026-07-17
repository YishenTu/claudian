import { grokProviderRegistration } from '@/providers/grok/registration';

describe('grokProviderRegistration', () => {
  it('is opt-in and wires registry contracts', () => {
    expect(grokProviderRegistration.id).toBe('grok');
    expect(grokProviderRegistration.displayName).toBe('Grok');
    expect(grokProviderRegistration.isEnabled({})).toBe(false);
    expect(grokProviderRegistration.isEnabled({
      providerConfigs: { grok: { enabled: true } },
    })).toBe(true);
    expect(grokProviderRegistration.environmentKeyPatterns?.some((pattern) => pattern.test('GROK_HOME'))).toBe(true);
    expect(grokProviderRegistration.environmentKeyPatterns?.some((pattern) => pattern.test('XAI_API_KEY'))).toBe(true);
    expect(grokProviderRegistration.capabilities.providerId).toBe('grok');
    expect(grokProviderRegistration.historyService).toBeTruthy();
    expect(grokProviderRegistration.workspace.initialize).toEqual(expect.any(Function));
    expect(grokProviderRegistration.settingsStorage.normalizeStored).toEqual(expect.any(Function));
  });
});
