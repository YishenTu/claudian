import '@/providers';

import {
  TEST_CODEX_CATALOG,
  TEST_CODEX_MODEL,
  TEST_CODEX_MODEL_LABEL,
} from '@test/helpers/codexModels';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderId,
  TitleGenerationService,
} from '@/core/providers/types';

describe('ProviderRegistry', () => {
  beforeEach(() => {
    ProviderWorkspaceRegistry.clear();
    ProviderWorkspaceRegistry.setServices('claude', {
    } as any);
    jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns capabilities for the default provider', () => {
    const caps = ProviderRegistry.getCapabilities();
    expect(caps.providerId).toBe('claude');
    expect(caps).toHaveProperty('supportsFork');
  });

  it('throws when an unknown provider is requested', () => {
    expect(() => ProviderRegistry.getCapabilities(
      'nonexistent' as any,
    )).toThrow('Provider "nonexistent" is not registered.');
  });

  it('returns Codex capabilities', () => {
    const caps = ProviderRegistry.getCapabilities('codex');
    expect(caps.providerId).toBe('codex');
    expect(caps.supportsFork).toBe(true);
    expect(caps.supportsRewind).toBe(false);
    expect(caps.reasoningControl).toBe('effort');
  });

  it('returns OpenCode capabilities', () => {
    const caps = ProviderRegistry.getCapabilities('opencode');
    expect(caps.providerId).toBe('opencode');
    expect(caps.supportsProviderCommands).toBe(true);
    expect(caps.supportsFork).toBe(true);
  });

  it('registers provider-owned subagent protocols outside the capability matrix', () => {
    const claudeAdapter = ProviderRegistry.getSubagentAdapter('claude');
    expect(claudeAdapter).toMatchObject({
      protocol: 'managed-agent',
    });
    const opencodeAdapter = ProviderRegistry.getSubagentAdapter('opencode');
    expect(opencodeAdapter).toMatchObject({
      protocol: 'managed-agent',
    });
    expect(ProviderRegistry.getSubagentAdapter('grok')).toMatchObject({
      protocol: 'lifecycle',
    });
    expect(ProviderRegistry.getSubagentAdapter('codex')).toMatchObject({
      protocol: 'lifecycle',
    });
    expect(ProviderRegistry.getSubagentAdapter('pi')).toBeNull();

    expect(claudeAdapter?.isSpawnTool('Agent')).toBe(true);
    expect(claudeAdapter?.isSpawnTool('Task')).toBe(true);
    expect(opencodeAdapter?.isSpawnTool('Agent')).toBe(true);
    expect(opencodeAdapter?.isSpawnTool('Task')).toBe(false);

    for (const providerId of ['claude', 'opencode', 'grok', 'codex', 'pi'] as const) {
      expect(ProviderRegistry.getCapabilities(providerId)).not.toHaveProperty(
        'supportsLegacySubagentTools',
      );
    }
  });

  it('returns Pi capabilities', () => {
    const caps = ProviderRegistry.getCapabilities('pi');
    expect(caps.providerId).toBe('pi');
    expect(caps.supportsProviderCommands).toBe(true);
    expect(caps.supportsImageAttachments).toBe(true);
    expect(caps.supportsTurnSteer).toBe(true);
    expect(caps.supportsFork).toBe(true);
  });

  it('lists registered provider ids', () => {
    const ids = ProviderRegistry.getRegisteredProviderIds();
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).toContain('grok');
    expect(ids).toContain('pi');
  });

  it('filters enabled provider ids using registration metadata', () => {
    expect(ProviderRegistry.getEnabledProviderIds({
      providerConfigs: {
        codex: { enabled: false },
      },
    })).toEqual(['claude']);
    expect(ProviderRegistry.getEnabledProviderIds({
      providerConfigs: {
        codex: { enabled: true },
      },
    })).toEqual(['codex', 'claude']);
    expect(ProviderRegistry.getEnabledProviderIds({
      providerConfigs: {
        claude: { enabled: false },
        codex: { enabled: true },
      },
    })).toEqual(['codex']);
    expect(ProviderRegistry.getEnabledProviderIds({
      providerConfigs: {
        codex: { enabled: true },
        opencode: { enabled: true },
      },
    })).toEqual(['opencode', 'codex', 'claude']);
    expect(ProviderRegistry.getEnabledProviderIds({
      providerConfigs: {
        codex: { enabled: true },
        grok: { enabled: true },
        opencode: { enabled: true },
        pi: { enabled: true },
      },
    })).toEqual(['opencode', 'pi', 'grok', 'codex', 'claude']);
  });

  it('exposes the blank-tab provider order from top to bottom', () => {
    expect(ProviderRegistry.getBlankTabProviderIds({
      providerConfigs: {
        codex: { enabled: true },
        grok: { enabled: true },
        opencode: { enabled: true },
        pi: { enabled: true },
      },
    })).toEqual(['claude', 'codex', 'grok', 'pi', 'opencode']);
  });

  it('exposes title generation models only from enabled providers', () => {
    const disabledSettings = {
      providerConfigs: {
        codex: {
          discoveredModels: TEST_CODEX_CATALOG,
          enabled: false,
        },
      },
    };
    const enabledSettings = {
      providerConfigs: {
        codex: {
          discoveredModels: TEST_CODEX_CATALOG,
          enabled: true,
        },
      },
    };

    expect(
      ProviderRegistry.getTitleGenerationModelOptions(disabledSettings)
        .some(option => option.value === `openai-codex/${TEST_CODEX_MODEL}`),
    ).toBe(false);
    expect(
      ProviderRegistry.getTitleGenerationModelOptions(enabledSettings)
        .some(option => option.value === `openai-codex/${TEST_CODEX_MODEL}`),
    ).toBe(true);

    const claudeDisabledSettings = {
      providerConfigs: {
        claude: { enabled: false },
        codex: {
          discoveredModels: TEST_CODEX_CATALOG,
          enabled: true,
        },
      },
    };
    expect(
      ProviderRegistry.getTitleGenerationModelOptions(claudeDisabledSettings)
        .some(option => option.value === 'sonnet'),
    ).toBe(false);
  });

  it('prefixes title generation model labels with their provider names', () => {
    const options = ProviderRegistry.getTitleGenerationModelOptions({
      providerConfigs: {
        claude: { discoveredModels: [{ value: 'sonnet', label: 'Sonnet', description: '' }], visibleModels: ['sonnet'] },
        codex: {
          discoveredModels: TEST_CODEX_CATALOG,
          enabled: true,
        },
      },
    });

    expect(options.find(option => option.value === `openai-codex/${TEST_CODEX_MODEL}`)?.label)
      .toBe(`Codex: ${TEST_CODEX_MODEL_LABEL}`);
    expect(options.find(option => option.value === 'sonnet')?.label)
      .toBe('Claude: Sonnet');
  });

  it('returns the display name from provider registration metadata', () => {
    expect(ProviderRegistry.getProviderDisplayName('claude')).toBe('Claude');
    expect(ProviderRegistry.getProviderDisplayName('codex')).toBe('Codex');
    expect(ProviderRegistry.getProviderDisplayName('grok')).toBe('Grok');
  });

  it('requires an explicit title model instead of selecting Claude automatically', async () => {
    const providerCalls: ProviderId[] = [];
    const originalCreate = ProviderRegistry.createTitleGenerationService.bind(ProviderRegistry);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService')
      .mockImplementation((plugin: any, providerId?: ProviderId) => {
        if (!providerId) {
          return originalCreate(plugin);
        }
        providerCalls.push(providerId);
        return createMockTitleService(providerId);
      });

    const service = ProviderRegistry.createTitleGenerationService({
      settings: {
        titleGenerationModel: '',
        providerConfigs: {
          codex: { enabled: true },
        },
      },
    } as any);
    const callback = jest.fn();

    await service.generateTitle('conv-1', 'hello', callback);

    expect(providerCalls).toEqual([]);
    expect(ProviderWorkspaceRegistry.ensureInitialized).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith('conv-1', {
      success: false,
      error: expect.stringContaining('Select an available title model'),
    });
  });

  it('does not select another provider when the title model is empty', async () => {
    const providerCalls: ProviderId[] = [];
    const originalCreate = ProviderRegistry.createTitleGenerationService.bind(ProviderRegistry);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService')
      .mockImplementation((plugin: any, providerId?: ProviderId) => {
        if (!providerId) {
          return originalCreate(plugin);
        }
        providerCalls.push(providerId);
        return createMockTitleService(providerId);
      });

    const service = ProviderRegistry.createTitleGenerationService({
      settings: {
        settingsProvider: 'codex',
        titleGenerationModel: '',
        providerConfigs: {
          claude: { enabled: false },
          codex: { enabled: true },
        },
      },
    } as any);

    const callback = jest.fn();
    await service.generateTitle('conv-1', 'hello', callback);

    expect(providerCalls).toEqual([]);
    expect(ProviderWorkspaceRegistry.ensureInitialized).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith('conv-1', {
      success: false,
      error: expect.stringContaining('Select an available title model'),
    });
  });

  it('routes explicit title model selections to the owning provider', async () => {
    const providerCalls: ProviderId[] = [];
    const originalCreate = ProviderRegistry.createTitleGenerationService.bind(ProviderRegistry);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService')
      .mockImplementation((plugin: any, providerId?: ProviderId) => {
        if (!providerId) {
          return originalCreate(plugin);
        }
        providerCalls.push(providerId);
        return createMockTitleService(providerId);
      });

    const service = ProviderRegistry.createTitleGenerationService({
      settings: {
        titleGenerationModel: TEST_CODEX_MODEL,
        providerConfigs: {
          codex: { enabled: true, visibleModels: [TEST_CODEX_MODEL], discoveredModels: TEST_CODEX_CATALOG },
        },
      },
    } as any);
    const callback = jest.fn();

    await service.generateTitle('conv-1', 'hello', callback);

    expect(providerCalls).toEqual(['codex']);
    expect(callback).toHaveBeenCalledWith('conv-1', {
      success: true,
      title: 'codex title',
    });
  });

  it('rejects a disabled title selection before initializing its provider', async () => {
    const providerCalls: ProviderId[] = [];
    const originalCreate = ProviderRegistry.createTitleGenerationService.bind(ProviderRegistry);
    jest.spyOn(ProviderRegistry, 'createTitleGenerationService')
      .mockImplementation((plugin: any, providerId?: ProviderId) => {
        if (!providerId) {
          return originalCreate(plugin);
        }
        providerCalls.push(providerId);
        return createMockTitleService(providerId);
      });

    const service = ProviderRegistry.createTitleGenerationService({
      settings: {
        titleGenerationModel: TEST_CODEX_MODEL,
        providerConfigs: {
          codex: {
            discoveredModels: TEST_CODEX_CATALOG,
            enabled: false,
          },
        },
      },
    } as any);

    const callback = jest.fn();
    await service.generateTitle('conv-1', 'hello', callback);

    expect(providerCalls).toEqual([]);
    expect(ProviderWorkspaceRegistry.ensureInitialized).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith('conv-1', {
      success: false,
      error: expect.stringContaining('Select an available title model'),
    });
  });

  it.each(['unknown-title-model', TEST_CODEX_MODEL])(
    'preserves an unavailable title selection without starting a provider: %s',
    async titleGenerationModel => {
      const settings = {
        titleGenerationModel,
        providerConfigs: {
          codex: { enabled: true, visibleModels: [], discoveredModels: TEST_CODEX_CATALOG },
        },
      };
      const callback = jest.fn();
      const service = ProviderRegistry.createTitleGenerationService({ settings } as any);
      await service.generateTitle('conversation', 'hello', callback);
      expect(ProviderWorkspaceRegistry.ensureInitialized).not.toHaveBeenCalled();
      expect(settings.titleGenerationModel).toBe(titleGenerationModel);
      expect(callback).toHaveBeenCalledWith('conversation', {
        success: false,
        error: expect.stringContaining('Select an available title model'),
      });
    },
  );

  it('rechecks title availability after provider initialization', async () => {
    const settings = {
      titleGenerationModel: TEST_CODEX_MODEL,
      providerConfigs: {
        codex: { enabled: true, visibleModels: [TEST_CODEX_MODEL], discoveredModels: TEST_CODEX_CATALOG },
      },
    };
    jest.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockImplementation(async () => {
      settings.providerConfigs.codex.enabled = false;
    });
    const createService = jest.spyOn(ProviderRegistry, 'createTitleGenerationService');
    const service = ProviderRegistry.createTitleGenerationService({ settings } as any);
    const callback = jest.fn();
    await service.generateTitle('conversation', 'hello', callback);
    expect(createService).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('conversation', {
      success: false,
      error: expect.stringContaining('became unavailable'),
    });
  });

});

function createMockTitleService(providerId: ProviderId): TitleGenerationService {
  return {
    cancel: jest.fn(),
    generateTitle: jest.fn(async (conversationId, _userMessage, callback) => {
      await callback(conversationId, {
        success: true,
        title: `${providerId} title`,
      });
    }),
  };
}
