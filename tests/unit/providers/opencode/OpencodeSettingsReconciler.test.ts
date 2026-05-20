import { getOpencodeDiscoveryState, updateOpencodeDiscoveryState } from '../../../../src/providers/opencode/discoveryState';
import { opencodeSettingsReconciler } from '../../../../src/providers/opencode/env/OpencodeSettingsReconciler';

describe('opencodeSettingsReconciler.normalizeModelVariantSettings', () => {
  it('migrates saved variant model ids into base model ids plus effort', () => {
    const settings: Record<string, unknown> = {
      effortLevel: '',
      model: 'opencode:anthropic/claude-sonnet-4/high',
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
            { label: 'Anthropic/Claude Sonnet 4 (high)', rawId: 'anthropic/claude-sonnet-4/high' },
          ],
          visibleModels: ['anthropic/claude-sonnet-4/high'],
        },
      },
      savedProviderEffort: {},
      savedProviderModel: {
        opencode: 'opencode:anthropic/claude-sonnet-4/high',
      },
      settingsProvider: 'opencode',
      titleGenerationModel: 'opencode:anthropic/claude-sonnet-4/high',
    };

    expect(opencodeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(settings).toMatchObject({
      effortLevel: 'high',
      model: 'opencode:anthropic/claude-sonnet-4',
      savedProviderEffort: {
        opencode: 'high',
      },
      savedProviderModel: {
        opencode: 'opencode:anthropic/claude-sonnet-4',
      },
      titleGenerationModel: 'opencode:anthropic/claude-sonnet-4',
    });
  });
});

describe('opencodeSettingsReconciler.handleEnvironmentChange', () => {
  it('clears provider-owned discovery state when environment changes', () => {
    const settings: Record<string, unknown> = {};
    updateOpencodeDiscoveryState(settings, {
      availableModes: [{ id: 'build', name: 'Build' }],
      discoveredModels: [{ label: 'OpenAI/GPT-5', rawId: 'openai/gpt-5' }],
    });

    expect(opencodeSettingsReconciler.handleEnvironmentChange?.(settings)).toBe(true);
    expect(getOpencodeDiscoveryState(settings)).toEqual({
      availableModes: [],
      discoveredModels: [],
      thinkingOptionsByModel: {},
    });
  });
});

describe('opencodeSettingsReconciler.reconcileModelWithEnvironment', () => {
  it('invalidates persisted OpenCode session state when the runtime database/config env changes', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        opencode: {
          enabled: true,
          environmentHash: 'OPENCODE_DB=/old/opencode.db',
          environmentVariables: 'OPENCODE_DB=/new/opencode.db\nOPENCODE_CONFIG=/tmp/opencode.json',
        },
      },
    };
    const conversations = [
      {
        id: 'conv-opencode',
        messages: [],
        providerId: 'opencode',
        providerState: { databasePath: '/old/opencode.db' },
        sessionId: 'session-1',
      },
      {
        id: 'conv-other',
        messages: [],
        providerId: 'claude',
        providerState: { providerSessionId: 'claude-session' },
        sessionId: 'claude-session',
      },
    ] as any;

    const result = opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, conversations);

    expect(result.changed).toBe(true);
    expect(result.invalidatedConversations).toHaveLength(1);
    expect(conversations[0].sessionId).toBeNull();
    expect(conversations[0].providerState).toBeUndefined();
    expect((settings.providerConfigs as any).opencode.environmentHash).toBe(
      'OPENCODE_CONFIG=/tmp/opencode.json|OPENCODE_DB=/new/opencode.db',
    );
  });
});
