import { VaultRetrievalService } from '@/core/retrieval/VaultRetrievalService';

type FakeMarkdownFile = {
  path: string;
  stat: { mtime: number; size: number };
};

function createVaultApp(contents: Record<string, string>, files: FakeMarkdownFile[]) {
  const activeFile = files[0];
  const app = {
    vault: {
      getMarkdownFiles: jest.fn(() => files),
      cachedRead: jest.fn(async (file: FakeMarkdownFile) => contents[file.path] ?? ''),
    },
    workspace: {
      getActiveFile: jest.fn(() => activeFile),
    },
  } as any;

  return app;
}

describe('VaultRetrievalService', () => {
  it('ranks heading and phrase matches ahead of weaker lexical matches', async () => {
    const files: FakeMarkdownFile[] = [
      { path: 'notes/rag.md', stat: { mtime: 1_000, size: 80 } },
      { path: 'notes/random.md', stat: { mtime: 1_000, size: 80 } },
    ];
    const app = createVaultApp(
      {
        'notes/rag.md': '# RAG architecture\n\nA local RAG pipeline combines retrieval and generation.',
        'notes/random.md': '# Misc\n\nRetrieval appears once in an unrelated sentence.',
      },
      files,
    );
    const service = new VaultRetrievalService(app);

    const results = await service.search('RAG retrieval', { limit: 5 });

    expect(results[0]).toMatchObject({
      path: 'notes/rag.md',
      heading: 'RAG architecture',
      matchedTerms: expect.arrayContaining(['rag', 'retrieval']),
    });
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].excerpt).toContain('local RAG pipeline');
  });

  it('refreshes cached blocks when a file stat changes', async () => {
    const file: FakeMarkdownFile = {
      path: 'notes/changing.md',
      stat: { mtime: 1_000, size: 20 },
    };
    const contents = { 'notes/changing.md': '# Old\n\nalpha' };
    const app = createVaultApp(contents, [file]);
    const service = new VaultRetrievalService(app);

    await expect(service.search('alpha')).resolves.toHaveLength(1);
    contents['notes/changing.md'] = '# New\n\nbeta';
    file.stat = { mtime: 2_000, size: 19 };

    await expect(service.search('beta')).resolves.toHaveLength(1);
    expect(app.vault.cachedRead).toHaveBeenCalledTimes(2);
  });

  it('builds an insight prompt with traceable source citations', async () => {
    const files: FakeMarkdownFile[] = [
      { path: 'notes/insight.md', stat: { mtime: 1_000, size: 60 } },
    ];
    const app = createVaultApp(
      { 'notes/insight.md': '# Semantic search\n\nSemantic search connects related notes.' },
      files,
    );
    const service = new VaultRetrievalService(app);

    const result = await service.buildInsightPrompt('semantic search');

    expect(result.results).toHaveLength(1);
    expect(result.prompt).toContain('Sources:');
    expect(result.prompt).toContain('[1] notes/insight.md#Semantic search');
    expect(result.prompt).toContain('Cite sources as [n].');
  });
});
