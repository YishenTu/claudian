import type { Conversation } from '@/core/types';
import {
  computeKimiEnvironmentHash,
  KIMI_ENVIRONMENT_KEY_PATTERNS,
  kimiSettingsReconciler,
} from '@/providers/kimi/env/KimiSettingsReconciler';
import { getKimiProviderSettings } from '@/providers/kimi/settings';

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
  getLegacyHostnameKey: () => 'legacy-host',
}));

describe('KimiSettingsReconciler', () => {
  it('owns only KIMI_ and MOONSHOT_ environment keys', () => {
    expect(KIMI_ENVIRONMENT_KEY_PATTERNS.map(pattern => ({
      flags: pattern.flags,
      source: pattern.source,
    }))).toEqual([
      { flags: 'i', source: '^KIMI_' },
      { flags: 'i', source: '^MOONSHOT_' },
    ]);
    expect(KIMI_ENVIRONMENT_KEY_PATTERNS.some(pattern => pattern.test('KIMI_API_KEY'))).toBe(true);
    expect(KIMI_ENVIRONMENT_KEY_PATTERNS.some(pattern => pattern.test('kimi_share_dir'))).toBe(true);
    expect(KIMI_ENVIRONMENT_KEY_PATTERNS.some(pattern => pattern.test('MOONSHOT_API_KEY'))).toBe(true);
    expect(KIMI_ENVIRONMENT_KEY_PATTERNS.some(pattern => pattern.test('OPENAI_API_KEY'))).toBe(false);
    expect(KIMI_ENVIRONMENT_KEY_PATTERNS.some(pattern => pattern.test('GROK_HOME'))).toBe(false);
  });

  it('computes a stable SHA-256 digest without exposing raw secret values', () => {
    const first = computeKimiEnvironmentHash({
      providerConfigs: {
        kimi: {
          cliPathsByHost: { 'current-host': '/bin/kimi' },
          environmentVariables: 'KIMI_API_KEY=super-secret\nMOONSHOT_API_KEY=other-secret',
        },
      },
    });
    const reordered = computeKimiEnvironmentHash({
      providerConfigs: {
        kimi: {
          cliPathsByHost: { 'current-host': '/bin/kimi' },
          environmentVariables: 'MOONSHOT_API_KEY=other-secret\nKIMI_API_KEY=super-secret',
        },
      },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(reordered);
    expect(first).not.toContain('super-secret');
    expect(first).not.toContain('other-secret');
  });

  it('declares reload and preserves all conversation bindings', () => {
    const kimiConversation = {
      messages: [],
      providerId: 'kimi',
      providerState: { sessionDirectory: '/tmp/.kimi/sessions/vault/session-1' },
      sessionId: 'session-1',
    } as unknown as Conversation;

    expect(kimiSettingsReconciler.environmentSessionPolicy).toBe('reload');
    expect(kimiSettingsReconciler.invalidateConversationSessions([kimiConversation]))
      .toEqual([]);
    expect(kimiConversation).toEqual(expect.objectContaining({
      providerState: { sessionDirectory: '/tmp/.kimi/sessions/vault/session-1' },
      sessionId: 'session-1',
    }));
  });

  it('leaves pristine disabled defaults untouched during startup reconciliation', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          enabled: false,
          environmentHash: '',
          environmentVariables: '',
        },
      },
    };

    expect(kimiSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(getKimiProviderSettings(settings).environmentHash).toBe('');
  });

  it('stores a fresh environment hash when construction inputs become stale', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true, marker: 'untouched' },
        kimi: {
          enabled: true,
          environmentHash: 'stale-hash',
          environmentVariables: 'KIMI_API_KEY=new-secret',
        },
      },
    };

    const result = kimiSettingsReconciler.reconcileModelWithEnvironment(settings, []);

    expect(result).toEqual({ changed: true, invalidatedConversations: [] });
    expect(getKimiProviderSettings(settings).environmentHash)
      .toBe(computeKimiEnvironmentHash(settings));
    expect(getKimiProviderSettings(settings).environmentHash).not.toBe('stale-hash');
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({
      enabled: true,
      marker: 'untouched',
    });
  });

  it('reports no change when the construction digest is current', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          enabled: true,
          environmentVariables: 'KIMI_SHARE_DIR=/tmp/kimi',
        },
      },
    };
    (settings.providerConfigs as Record<string, Record<string, unknown>>).kimi.environmentHash =
      computeKimiEnvironmentHash(settings);

    expect(kimiSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
  });

  it('normalizes kimi:-scoped selections in every shared model slot', () => {
    const settings: Record<string, unknown> = {
      model: '  kimi:kimi-for-coding  ',
      titleGenerationModel: ' kimi:kimi-k2,thinking ',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        kimi: ' kimi:kimi-k2 ',
      },
    };

    expect(kimiSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(settings).toEqual({
      model: 'kimi:kimi-for-coding',
      titleGenerationModel: 'kimi:kimi-k2,thinking',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        kimi: 'kimi:kimi-k2',
      },
    });
  });

  it('leaves normalized, unqualified, and unrelated provider selections unchanged', () => {
    const settings: Record<string, unknown> = {
      model: 'kimi:kimi-for-coding',
      titleGenerationModel: 'grok/grok-4',
      savedProviderModel: {
        codex: 'gpt-5.4',
        kimi: 'kimi:',
      },
    };

    expect(kimiSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
    expect(settings).toEqual({
      model: 'kimi:kimi-for-coding',
      titleGenerationModel: 'grok/grok-4',
      savedProviderModel: {
        codex: 'gpt-5.4',
        kimi: 'kimi:',
      },
    });
  });
});
