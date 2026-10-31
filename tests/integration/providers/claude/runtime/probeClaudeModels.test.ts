import type { SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

const native = await vi.importActual<typeof import('@test/__mocks__/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');

import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { probeClaudeCatalog } from '@/providers/claude/runtime/probeClaudeModels';

let vault: DesktopVault;
beforeAll(async () => { vault = await DesktopVault.create(); });
afterAll(async () => { await vault.dispose(); });

beforeEach(() => native.resetMockMessages());

async function host(workingDirectory: string | null = '/vault'): Promise<ProviderRuntimeHost> {
  const fixture = await createProviderHostFixture({ vault,
    settings: { providerConfigs: { claude: {} } },
    overrides: { workingDirectory, getResolvedProviderCliPath: async () => '/bin/claude' },
  });
  return fixture.host.getRuntimeHost('claude');
}

describe('Claude SDK catalog probe', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('maps reported models and output styles, retaining known effort levels and dropping malformed ones', async () => {
    native.setMockInitializationResult(async () => ({ models: [
        { value: 'opus', displayName: 'Opus', description: 'Capable', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high', 'max'] },
        { value: 'haiku', displayName: 'Haiku', description: '' },
        { value: 'my-model', displayName: '', description: 'Configured by SDK', resolvedModel: '', supportedEffortLevels: ['low', 'turbo', 7] },
      ], available_output_styles: ['default', ' Concise ', 'My Style', 'Concise', '', 3] } as unknown as SDKControlInitializeResponse));
    expect(await probeClaudeCatalog(await host())).toEqual({
      models: [
        { value: 'opus', label: 'Opus', description: 'Capable', resolvedModel: 'claude-opus-5-5', reasoningMetadataResolved: true, supportedEffortLevels: ['low', 'high', 'max'] },
        { value: 'haiku', label: 'Haiku', description: '', reasoningMetadataResolved: true, supportedEffortLevels: [] },
        { value: 'my-model', label: 'my-model', description: 'Configured by SDK', reasoningMetadataResolved: true, supportedEffortLevels: ['low'] },
      ],
      outputStyles: ['default', 'Concise', 'My Style'],
    });
  });

  it('reports a missing local vault as a discovery failure', async () => {
    await expect(probeClaudeCatalog(await host(null))).rejects.toThrow('requires a local vault');
    expect(native.getQueryCallCount()).toBe(0);
  });
});
