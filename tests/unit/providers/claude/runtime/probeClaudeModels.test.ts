import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { probeClaudeModels } from '@/providers/claude/runtime/probeClaudeModels';

const mockQuery = jest.fn();
jest.mock('@/providers/claude/loadClaudeAgentSDK', () => ({ loadClaudeAgentQuery: async () => mockQuery }));
jest.mock('@/utils/path', () => ({ getVaultPath: () => '/vault' }));
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'), getEnhancedPath: () => '/bin',
}));

function host(loadUserSettings = true): ProviderHost {
  return {
    app: {},
    settings: { model: 'selected-chat-model', providerConfigs: { claude: { loadUserSettings } } },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/bin/claude'),
    getActiveEnvironmentVariables: () => 'ANTHROPIC_BASE_URL=https://gateway.example\nANTHROPIC_MODEL=my-model',
  } as unknown as ProviderHost;
}

describe('Claude SDK model probe', () => {
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

  it.each([true, false])('uses native settings sources (user settings: %s) without overriding the configured model', async enabled => {
    const close = jest.fn();
    mockQuery.mockReturnValue({
      supportedModels: async () => [{ value: 'my-model', displayName: 'Gateway model', description: 'Configured by SDK' }],
      close,
    });
    expect(await probeClaudeModels(host(enabled))).toEqual([
      { value: 'my-model', label: 'Gateway model', description: 'Configured by SDK' },
    ]);
    const { options, prompt } = mockQuery.mock.calls[0][0] as { options: Options; prompt: AsyncGenerator };
    expect(options.model).toBeUndefined();
    expect(options.settingSources).toEqual(enabled ? ['user', 'project', 'local'] : ['project', 'local']);
    expect(options.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_MODEL: 'my-model' });
    expect(options.persistSession).toBe(false);
    expect(await prompt.next()).toEqual({ done: true, value: undefined });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('retains reported effort levels and drops malformed ones', async () => {
    mockQuery.mockReturnValue({
      supportedModels: async () => [
        { value: 'opus', displayName: 'Opus', description: '', supportedEffortLevels: ['low', 'high', 'max'] },
        { value: 'haiku', displayName: 'Haiku', description: '', supportedEffortLevels: [] },
        { value: 'other', displayName: 'Other', description: '', supportedEffortLevels: ['low', 'turbo', 7] },
      ],
      close: jest.fn(),
    });
    expect(await probeClaudeModels(host())).toEqual([
      { value: 'opus', label: 'Opus', description: '', supportedEffortLevels: ['low', 'high', 'max'] },
      { value: 'haiku', label: 'Haiku', description: '', supportedEffortLevels: [] },
      { value: 'other', label: 'Other', description: '', supportedEffortLevels: ['low'] },
    ]);
  });

  it('cancels and closes an in-flight SDK process', async () => {
    const close = jest.fn();
    mockQuery.mockReturnValue({ supportedModels: () => new Promise(() => {}), close });
    const controller = new AbortController();
    const pending = probeClaudeModels(host(), controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
