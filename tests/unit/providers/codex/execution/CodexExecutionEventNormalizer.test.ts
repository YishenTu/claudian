import { adaptCodexStreamChunk } from '@/providers/codex/execution/CodexExecutionEventNormalizer';

describe('CodexExecutionEventNormalizer', () => {
  it('adapts citation chunks without provider-owned tracking IDs', () => {
    const citations = {
      kind: 'memory' as const,
      entries: [{
        path: 'MEMORY.md',
        lineStart: 10,
        lineEnd: 12,
        note: 'Used project conventions',
      }],
    };

    expect(adaptCodexStreamChunk({ type: 'citations', citations })).toEqual({
      type: 'citations',
      citations,
    });
  });
});
