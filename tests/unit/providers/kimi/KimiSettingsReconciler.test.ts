import { kimiSettingsReconciler } from '@/providers/kimi/env/KimiSettingsReconciler';

describe('kimiSettingsReconciler.reconcileModelWithEnvironment', () => {
  it('persists a digest instead of copying Kimi secrets into provider settings', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          enabled: true,
          environmentHash: '',
          environmentVariables: [
            'KIMI_CODE_HOME=/tmp/kimi-home',
            'KIMI_API_KEY=super-secret-value',
          ].join('\n'),
        },
      },
    };
    const conversations = [{
      id: 'conv-kimi',
      messages: [],
      providerId: 'kimi',
      providerState: { sessionId: 'session-1' },
      sessionId: 'session-1',
    }] as any;

    const first = kimiSettingsReconciler.reconcileModelWithEnvironment(settings, conversations);
    const persistedHash = (settings.providerConfigs as any).kimi.environmentHash as string;

    expect(first.changed).toBe(true);
    expect(first.invalidatedConversations).toHaveLength(1);
    expect(conversations[0].sessionId).toBeNull();
    expect(persistedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(persistedHash).not.toContain('super-secret-value');

    const second = kimiSettingsReconciler.reconcileModelWithEnvironment(settings, conversations);
    expect(second).toEqual({ changed: false, invalidatedConversations: [] });
  });
});
