import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

const { getQueryCallCount, resetMockMessages, setMockInitializationResult } = await vi.importActual<typeof import('@test/__mocks__/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');

import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { probeRuntimeCommands } from '@/providers/claude/commands/probeRuntimeCommands';

let vault: DesktopVault;
beforeAll(async () => { vault = await DesktopVault.create(); });
afterAll(async () => { await vault.dispose(); });

beforeEach(() => resetMockMessages());

async function createHost(
  cliPath: string | null = '/mock/claude',
  workingDirectory: string | null = '/test/vault',
): Promise<ProviderRuntimeHost> {
  const fixture = await createProviderHostFixture({ vault,
    settings: {},
    overrides: { workingDirectory, getResolvedProviderCliPath: async () => cliPath },
  });
  return fixture.host.getRuntimeHost('claude');
}

describe('probeRuntimeCommands', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it.each([
    ['no local vault', true, '/mock/claude'],
    ['no Claude CLI', false, null],
  ] as const)('resolves empty when %s can run discovery', async (_case, missingVault, cliPath) => {
    await expect(probeRuntimeCommands(await createHost(cliPath, missingVault ? null : '/test/vault'))).resolves.toEqual([]);
    expect(getQueryCallCount()).toBe(0);
  });

  it('rejects when the CLI cannot answer initialization', async () => {
    setMockInitializationResult(() => Promise.reject(new Error('control request failed')));

    await expect(probeRuntimeCommands(await createHost())).rejects.toThrow('control request failed');
  });
});
