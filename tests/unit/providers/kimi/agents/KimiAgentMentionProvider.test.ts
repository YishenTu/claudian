import { KimiAgentMentionProvider } from '@/providers/kimi/agents/KimiAgentMentionProvider';
import type { KimiAgentStorage } from '@/providers/kimi/agents/KimiAgentStorage';

function createMockStorage(): jest.Mocked<Pick<KimiAgentStorage, 'loadAll'>> {
  return {
    loadAll: jest.fn(async () => [
      {
        description: 'Reviews code for correctness.',
        filePath: '.kimi-code/agents/code-reviewer.md',
        name: 'code-reviewer',
        prompt: 'Review code like an owner.',
      },
      {
        description: 'Audits vault notes.',
        filePath: '.agents/agents/note-auditor.md',
        name: 'note-auditor',
        prompt: 'Audit every note carefully.',
      },
    ]),
  };
}

describe('KimiAgentMentionProvider', () => {
  it('loads agents once and searches by name and description', async () => {
    const storage = createMockStorage();
    const provider = new KimiAgentMentionProvider(storage as unknown as KimiAgentStorage);

    expect(provider.isLoaded()).toBe(false);
    await provider.ensureLoaded();
    await provider.ensureLoaded();

    expect(provider.isLoaded()).toBe(true);
    expect(storage.loadAll).toHaveBeenCalledTimes(1);
    expect(provider.searchAgents('review')).toEqual([
      {
        description: 'Reviews code for correctness.',
        id: 'code-reviewer',
        name: 'code-reviewer',
        source: 'vault',
      },
    ]);
    expect(provider.searchAgents('notes')).toEqual([
      {
        description: 'Audits vault notes.',
        id: 'note-auditor',
        name: 'note-auditor',
        source: 'vault',
      },
    ]);
    expect(provider.searchAgents('')).toHaveLength(2);
    expect(provider.searchAgents('missing')).toEqual([]);
  });

  it('reloads agents through loadAgents', async () => {
    const storage = createMockStorage();
    const provider = new KimiAgentMentionProvider(storage as unknown as KimiAgentStorage);

    await provider.loadAgents();
    await provider.loadAgents();

    expect(storage.loadAll).toHaveBeenCalledTimes(2);
  });
});
