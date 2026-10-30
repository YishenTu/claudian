import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { probeRuntimeCommands } from '@/providers/claude/commands/probeRuntimeCommands';

const mockQuery = vi.fn();
vi.mock('@/providers/claude/loadClaudeAgentSDK', () => ({ loadClaudeAgentQuery: async () => mockQuery }));

function createMockPlugin(
  cliPath: string | null = '/mock/claude',
  workingDirectory: string | null = '/test/vault',
): ProviderRuntimeHost {
  return runtimeHostFor({
    settings: {},
    workingDirectory,
    getResolvedProviderCliPath: vi.fn().mockResolvedValue(cliPath),
  }, 'claude');
}

function initializeWith(initializationResult: () => Promise<{ commands?: unknown }>, skills: string[] = []) {
  mockQuery.mockReturnValue({
    initializationResult,
    supportedCommands: async () => (await initializationResult()).commands,
    next: vi.fn().mockResolvedValue({ done: false, value: { type: 'system', subtype: 'init', skills } }),
    close: vi.fn(),
  });
}

describe('probeRuntimeCommands', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it.each([
    ['no local vault', true, '/mock/claude'],
    ['no Claude CLI', false, null],
  ] as const)('resolves empty when %s can run discovery', async (_case, missingVault, cliPath) => {
    await expect(probeRuntimeCommands(createMockPlugin(cliPath, missingVault ? null : '/test/vault'))).resolves.toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects when the CLI cannot answer initialization', async () => {
    initializeWith(() => Promise.reject(new Error('control request failed')));

    await expect(probeRuntimeCommands(createMockPlugin())).rejects.toThrow('control request failed');
  });
});
