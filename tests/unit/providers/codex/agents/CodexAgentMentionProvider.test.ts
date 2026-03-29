import { CodexAgentMentionProvider } from '../../../../../src/providers/codex/agents/CodexAgentMentionProvider';
import type { CodexSubagentStorage } from '../../../../../src/providers/codex/storage/CodexSubagentStorage';
import type { CodexSubagentDefinition } from '../../../../../src/providers/codex/types/subagent';

function makeAgent(overrides: Partial<CodexSubagentDefinition> = {}): CodexSubagentDefinition {
  return {
    name: 'test-agent',
    description: 'A test agent',
    developerInstructions: 'do stuff',
    ...overrides,
  };
}

function makeMockStorage(agents: CodexSubagentDefinition[] = []): CodexSubagentStorage {
  return { loadAll: async () => agents } as unknown as CodexSubagentStorage;
}

describe('CodexAgentMentionProvider', () => {
  it('returns empty array before loadAgents is called', () => {
    const provider = new CodexAgentMentionProvider(makeMockStorage([makeAgent()]));
    expect(provider.searchAgents('')).toEqual([]);
  });

  it('returns all agents for empty query after load', async () => {
    const agents = [
      makeAgent({ name: 'alpha', description: 'First agent' }),
      makeAgent({ name: 'beta', description: 'Second agent' }),
    ];
    const provider = new CodexAgentMentionProvider(makeMockStorage(agents));
    await provider.loadAgents();

    const results = provider.searchAgents('');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: 'alpha',
      name: 'alpha',
      description: 'First agent',
      source: 'vault',
    });
  });

  it('filters agents by name', async () => {
    const agents = [
      makeAgent({ name: 'code-reviewer', description: 'Reviews code' }),
      makeAgent({ name: 'test-writer', description: 'Writes tests' }),
    ];
    const provider = new CodexAgentMentionProvider(makeMockStorage(agents));
    await provider.loadAgents();

    const results = provider.searchAgents('review');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('code-reviewer');
  });

  it('filters agents by description', async () => {
    const agents = [
      makeAgent({ name: 'alpha', description: 'Handles deployment tasks' }),
      makeAgent({ name: 'beta', description: 'Manages infrastructure' }),
    ];
    const provider = new CodexAgentMentionProvider(makeMockStorage(agents));
    await provider.loadAgents();

    const results = provider.searchAgents('infra');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('beta');
  });

  it('performs case-insensitive search', async () => {
    const agents = [makeAgent({ name: 'MyAgent', description: 'Does things' })];
    const provider = new CodexAgentMentionProvider(makeMockStorage(agents));
    await provider.loadAgents();

    expect(provider.searchAgents('myagent')).toHaveLength(1);
    expect(provider.searchAgents('MYAGENT')).toHaveLength(1);
  });

  it('all results have source "vault"', async () => {
    const agents = [
      makeAgent({ name: 'a', description: 'x' }),
      makeAgent({ name: 'b', description: 'y' }),
    ];
    const provider = new CodexAgentMentionProvider(makeMockStorage(agents));
    await provider.loadAgents();

    for (const result of provider.searchAgents('')) {
      expect(result.source).toBe('vault');
    }
  });
});
