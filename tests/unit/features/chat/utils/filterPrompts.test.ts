import type { StoredPrompt } from '@/core/storage/PromptLibraryStorage';
import { filterPrompts } from '@/features/chat/utils/filterPrompts';

const mk = (name: string, content: string): StoredPrompt => ({
  id: name, name, content, updatedAt: 0,
});

describe('filterPrompts', () => {
  it('returns all when query is blank', () => {
    const p = [mk('A', 'x'), mk('B', 'y')];
    expect(filterPrompts(p, '')).toEqual(p);
    expect(filterPrompts(p, '   ')).toEqual(p);
  });

  it('matches name case-insensitively', () => {
    const p = [mk('Summarize', 'x'), mk('Translate', 'y')];
    expect(filterPrompts(p, 'summ')).toEqual([p[0]]);
  });

  it('matches content', () => {
    const p = [mk('A', 'explain the code'), mk('B', 'rewrite')];
    expect(filterPrompts(p, 'code')).toEqual([p[0]]);
  });
});
