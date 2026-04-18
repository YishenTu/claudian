import { resolveLineRangeMentions } from '@/utils/lineRangeMention';

describe('resolveLineRangeMentions', () => {
  const makeReadFile = (content: string) =>
    (_path: string) => Promise.resolve(content);

  it('returns prompt unchanged when map is empty', async () => {
    const result = await resolveLineRangeMentions(
      'hello world',
      new Map(),
      makeReadFile('line1\nline2\nline3')
    );
    expect(result).toBe('hello world');
  });

  it('appends editor_selection XML for a single mention', async () => {
    const fileContent = 'line1\nline2\nline3\nline4\nline5';
    const map = new Map([['notes/foo.md', { startLine: 2, endLine: 4 }]]);
    const result = await resolveLineRangeMentions(
      'check this @foo.md#2-4',
      map,
      makeReadFile(fileContent)
    );
    expect(result).toBe(
      'check this @foo.md#2-4\n\n' +
      '<editor_selection path="notes/foo.md" lines="2-4">\n' +
      'line2\nline3\nline4\n' +
      '</editor_selection>'
    );
  });

  it('appends multiple XML blocks for multiple mentions', async () => {
    const map = new Map([
      ['a.md', { startLine: 1, endLine: 2 }],
      ['b.md', { startLine: 3, endLine: 3 }],
    ]);
    const readFile = (path: string) =>
      path === 'a.md'
        ? Promise.resolve('a1\na2\na3')
        : Promise.resolve('b1\nb2\nb3');

    const result = await resolveLineRangeMentions('prompt', map, readFile);
    expect(result).toContain('<editor_selection path="a.md" lines="1-2">');
    expect(result).toContain('<editor_selection path="b.md" lines="3-3">');
  });

  it('clamps endLine when it exceeds file length', async () => {
    const map = new Map([['x.md', { startLine: 3, endLine: 99 }]]);
    const result = await resolveLineRangeMentions(
      'prompt',
      map,
      makeReadFile('l1\nl2\nl3')
    );
    expect(result).toContain('lines="3-3"');
    expect(result).toContain('l3');
    expect(result).not.toContain('undefined');
  });

  it('returns prompt unchanged when readFile throws', async () => {
    const map = new Map([['missing.md', { startLine: 1, endLine: 2 }]]);
    const readFile = () => Promise.reject(new Error('file not found'));
    const result = await resolveLineRangeMentions('prompt', map, readFile);
    expect(result).toBe('prompt');
  });
});
