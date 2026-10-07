import type { ProviderHost } from '@/core/providers/ProviderHost';
import { probeRuntimeCommands } from '@/providers/claude/commands/probeRuntimeCommands';
import { getVaultPath } from '@/utils/path';

const mockQuery = jest.fn();
jest.mock('@/providers/claude/loadClaudeAgentSDK', () => ({ loadClaudeAgentQuery: async () => mockQuery }));
jest.mock('@/utils/path', () => ({ ...jest.requireActual('@/utils/path'), getVaultPath: jest.fn(() => '/test/vault') }));

function createMockPlugin(cliPath: string | null = '/mock/claude'): ProviderHost {
  return {
    app: {},
    settings: {},
    getResolvedProviderCliPath: jest.fn().mockResolvedValue(cliPath),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
  } as unknown as ProviderHost;
}

function initializeWith(initializationResult: () => Promise<{ commands?: unknown }>, skills: string[] = []) {
  mockQuery.mockReturnValue({
    initializationResult,
    supportedCommands: async () => (await initializationResult()).commands,
    next: jest.fn().mockResolvedValue({ done: false, value: { type: 'system', subtype: 'init', skills } }),
    close: jest.fn(),
  });
}

describe('probeRuntimeCommands', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('maps initialization commands and keeps Claude Code built-ins and skills distinguishable', async () => {
    initializeWith(async () => ({ commands: [
      { name: 'commit', description: 'Create a commit', argumentHint: '' },
      { name: 'compact', description: 'Compact context', argumentHint: '<focus>', builtin: true },
      { name: 'pdf', description: 'Work with PDFs', argumentHint: '' },
      { name: 'review', description: 'Review changes', argumentHint: '', builtin: true },
    ] }), ['commit', 'documents:pdf', 'review']);

    expect(await probeRuntimeCommands(createMockPlugin())).toEqual([
      { id: 'sdk:commit', name: 'commit', description: 'Create a commit', argumentHint: '', content: '', source: 'sdk', kind: 'skill' },
      { id: 'sdk:compact', name: 'compact', description: 'Compact context', argumentHint: '<focus>', content: '', source: 'builtin', kind: 'command' },
      { id: 'sdk:pdf', name: 'pdf', description: 'Work with PDFs', argumentHint: '', content: '', source: 'sdk', kind: 'skill' },
      { id: 'sdk:review', name: 'review', description: 'Review changes', argumentHint: '', content: '', source: 'builtin', kind: 'skill' },
    ]);
  });

  it.each([
    ['no local vault', true, '/mock/claude'],
    ['no Claude CLI', false, null],
  ] as const)('resolves empty when %s can run discovery', async (_case, missingVault, cliPath) => {
    if (missingVault) jest.mocked(getVaultPath).mockReturnValueOnce(null);
    await expect(probeRuntimeCommands(createMockPlugin(cliPath))).resolves.toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects when the CLI cannot answer initialization', async () => {
    initializeWith(() => Promise.reject(new Error('control request failed')));

    await expect(probeRuntimeCommands(createMockPlugin())).rejects.toThrow('control request failed');
  });
});
