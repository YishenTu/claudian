import { StoredAgentMentionProvider } from '@/core/providers/agents/StoredAgentMentionProvider';

interface TestAgent {
  name: string;
  description: string;
  mentionable: boolean;
}

function createAgent(overrides: Partial<TestAgent> = {}): TestAgent {
  return {
    name: 'reviewer',
    description: 'Reviews code',
    mentionable: true,
    ...overrides,
  };
}

describe('StoredAgentMentionProvider', () => {
  it('returns no results until the first load completes', () => {
    const provider = new StoredAgentMentionProvider(
      { loadAll: async () => [createAgent()] },
      { source: 'vault' },
    );

    expect(provider.isLoaded()).toBe(false);
    expect(provider.searchAgents('')).toEqual([]);
  });

  it('loads once for concurrent callers and searches names and descriptions case-insensitively', async () => {
    let resolveLoad!: (agents: TestAgent[]) => void;
    const loadAll = jest.fn(() => new Promise<TestAgent[]>((resolve) => {
      resolveLoad = resolve;
    }));
    const provider = new StoredAgentMentionProvider(
      { loadAll },
      { source: 'vault' },
    );

    const firstLoad = provider.ensureLoaded();
    const secondLoad = provider.ensureLoaded();
    expect(loadAll).toHaveBeenCalledTimes(1);

    resolveLoad([
      createAgent({ name: 'Security Review', description: 'Finds auth issues' }),
      createAgent({ name: 'Performance', description: 'Profiles hot paths' }),
    ]);
    await Promise.all([firstLoad, secondLoad]);

    expect(provider.isLoaded()).toBe(true);
    expect(provider.searchAgents('SECURITY')).toEqual([{
      id: 'Security Review',
      name: 'Security Review',
      description: 'Finds auth issues',
      source: 'vault',
    }]);
    expect(provider.searchAgents('HOT PATHS')).toEqual([{
      id: 'Performance',
      name: 'Performance',
      description: 'Profiles hot paths',
      source: 'vault',
    }]);
  });

  it('applies the provider-owned mention predicate before projection', async () => {
    const provider = new StoredAgentMentionProvider(
      {
        loadAll: async () => [
          createAgent({ name: 'visible' }),
          createAgent({ name: 'hidden', mentionable: false }),
        ],
      },
      {
        isMentionable: agent => agent.mentionable,
        source: 'global',
      },
    );

    await provider.loadAgents();

    expect(provider.searchAgents('')).toEqual([{
      id: 'visible',
      name: 'visible',
      description: 'Reviews code',
      source: 'global',
    }]);
  });

  it('allows a failed initial load to be retried', async () => {
    const loadAll = jest.fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce([createAgent()]);
    const provider = new StoredAgentMentionProvider<TestAgent>(
      { loadAll },
      { source: 'vault' },
    );

    await expect(provider.ensureLoaded()).rejects.toThrow('read failed');
    expect(provider.isLoaded()).toBe(false);

    await provider.ensureLoaded();

    expect(loadAll).toHaveBeenCalledTimes(2);
    expect(provider.searchAgents('review')).toHaveLength(1);
  });

  it('keeps the last successful snapshot when a refresh fails', async () => {
    const loadAll = jest.fn()
      .mockResolvedValueOnce([createAgent({ name: 'stable' })])
      .mockRejectedValueOnce(new Error('refresh failed'));
    const provider = new StoredAgentMentionProvider<TestAgent>(
      { loadAll },
      { source: 'vault' },
    );
    await provider.loadAgents();

    await expect(provider.loadAgents()).rejects.toThrow('refresh failed');

    expect(provider.isLoaded()).toBe(true);
    expect(provider.searchAgents('')).toEqual([{
      id: 'stable',
      name: 'stable',
      description: 'Reviews code',
      source: 'vault',
    }]);
  });
});
