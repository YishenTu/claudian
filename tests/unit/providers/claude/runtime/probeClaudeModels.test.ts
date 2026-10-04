import type { ProviderHost } from '@/core/providers/ProviderHost';
import { probeClaudeCatalog } from '@/providers/claude/runtime/probeClaudeModels';
import { getVaultPath } from '@/utils/path';

const mockQuery = jest.fn();
jest.mock('@/providers/claude/loadClaudeAgentSDK', () => ({ loadClaudeAgentQuery: async () => mockQuery }));
jest.mock('@/utils/path', () => ({ ...jest.requireActual('@/utils/path'), getVaultPath: jest.fn(() => '/vault') }));

function host(): ProviderHost {
  return {
    app: {},
    settings: { providerConfigs: { claude: {} } },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/bin/claude'),
    getActiveEnvironmentVariables: () => '',
  } as unknown as ProviderHost;
}

describe('Claude SDK catalog probe', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('maps reported models and output styles, retaining known effort levels and dropping malformed ones', async () => {
    mockQuery.mockReturnValue({
      initializationResult: async () => ({ models: [
        { value: 'opus', displayName: 'Opus', description: 'Capable', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high', 'max'] },
        { value: 'haiku', displayName: 'Haiku', description: '' },
        { value: 'my-model', displayName: '', description: 'Configured by SDK', resolvedModel: '', supportedEffortLevels: ['low', 'turbo', 7] },
      ], available_output_styles: ['default', ' Concise ', 'My Style', 'Concise', '', 3] }),
      supportedCommands: async () => [],
      next: async () => ({ done: false, value: { type: 'system', subtype: 'init' } }),
      close: jest.fn(),
    });
    expect(await probeClaudeCatalog(host())).toEqual({
      models: [
        { value: 'opus', label: 'Opus', description: 'Capable', resolvedModel: 'claude-opus-5-5', reasoningMetadataResolved: true, supportedEffortLevels: ['low', 'high', 'max'] },
        { value: 'haiku', label: 'Haiku', description: '', reasoningMetadataResolved: true, supportedEffortLevels: [] },
        { value: 'my-model', label: 'my-model', description: 'Configured by SDK', reasoningMetadataResolved: true, supportedEffortLevels: ['low'] },
      ],
      outputStyles: ['default', 'Concise', 'My Style'],
    });
  });

  it('reports a missing local vault as a discovery failure', async () => {
    jest.mocked(getVaultPath).mockReturnValueOnce(null);
    await expect(probeClaudeCatalog(host())).rejects.toThrow('requires a local vault');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
