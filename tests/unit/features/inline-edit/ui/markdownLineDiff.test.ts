import { buildMarkdownDiffDocuments, computeMarkdownDiff } from '@/features/inline-edit/ui/markdownLineDiff';

describe('markdown line diff', () => {
  it.each([
    {
      name: 'small middle replacement between equal boundaries',
      oldMarkdown: 'Intro\nold\nEnd\n',
      newMarkdown: 'Intro\nnew\nEnd\n',
      expectedDiffOps: [
        { type: 'equal', text: 'Intro\n' },
        { type: 'delete', text: 'old\n' },
        { type: 'insert', text: 'new\n' },
        { type: 'equal', text: 'End\n' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'repeated equal line tie retains the matching suffix',
      oldMarkdown: 'Item\nItem\n',
      newMarkdown: 'Item\n',
      expectedDiffOps: [{ type: 'delete', text: 'Item\n' }, { type: 'equal', text: 'Item\n' }],
      expectedDocuments: ['delete'],
    },
    {
      name: 'insertion between equal boundaries',
      oldMarkdown: 'head\nfoot',
      newMarkdown: 'head\nmiddle\nfoot',
      expectedDiffOps: [
        { type: 'equal', text: 'head\n' }, { type: 'insert', text: 'middle\n' }, { type: 'equal', text: 'foot' },
      ],
      expectedDocuments: ['insert'],
    },
    {
      name: 'deletion between equal boundaries',
      oldMarkdown: 'head\nmiddle\nfoot',
      newMarkdown: 'head\nfoot',
      expectedDiffOps: [
        { type: 'equal', text: 'head\n' }, { type: 'delete', text: 'middle\n' }, { type: 'equal', text: 'foot' },
      ],
      expectedDocuments: ['delete'],
    },
    {
      name: 'matching interior regions still use the line diff',
      oldMarkdown: 'A\nold\ncommon\nremove\nZ',
      newMarkdown: 'A\nnew\ncommon\nadd\nZ',
      expectedDiffOps: [
        { type: 'equal', text: 'A\n' }, { type: 'delete', text: 'old\n' }, { type: 'insert', text: 'new\n' },
        { type: 'equal', text: 'common\n' }, { type: 'delete', text: 'remove\n' }, { type: 'insert', text: 'add\n' },
        { type: 'equal', text: 'Z' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'an interior LCS tie keeps delete-before-insert ordering',
      oldMarkdown: 'head\nA\nB\ntail',
      newMarkdown: 'head\nB\nA\ntail',
      expectedDiffOps: [
        { type: 'equal', text: 'head\n' }, { type: 'delete', text: 'A\n' },
        { type: 'equal', text: 'B\n' }, { type: 'insert', text: 'A\n' },
        { type: 'equal', text: 'tail' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'CRLF line endings stay exact around a middle replacement',
      oldMarkdown: 'head\r\nold\r\nfoot\r\n',
      newMarkdown: 'head\r\nnew\r\nfoot\r\n',
      expectedDiffOps: [
        { type: 'equal', text: 'head\r\n' }, { type: 'delete', text: 'old\r\n' },
        { type: 'insert', text: 'new\r\n' }, { type: 'equal', text: 'foot\r\n' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'fenced code with block context',
      oldMarkdown: '```ts\nconst value = 1;\n```',
      newMarkdown: '```ts\nconst value = 2;\n```',
      expectedDiffOps: [
        { type: 'equal', text: '```ts\n' },
        { type: 'delete', text: 'const value = 1;\n' },
        { type: 'insert', text: 'const value = 2;\n' },
        { type: 'equal', text: '```' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'unchanged text',
      oldMarkdown: 'Hello world',
      newMarkdown: 'Hello world',
      expectedDiffOps: [{ type: 'equal', text: 'Hello world' }],
      expectedDocuments: ['equal'],
    },
    {
      name: 'insertion into empty text',
      oldMarkdown: '',
      newMarkdown: 'New text',
      expectedDiffOps: [{ type: 'insert', text: 'New text' }],
      expectedDocuments: ['insert'],
    },
    {
      name: 'complete deletion',
      oldMarkdown: 'Removed text',
      newMarkdown: '',
      expectedDiffOps: [{ type: 'delete', text: 'Removed text' }],
      expectedDocuments: ['delete'],
    },
    {
      name: 'empty documents',
      oldMarkdown: '',
      newMarkdown: '',
      expectedDiffOps: [],
      expectedDocuments: [],
    },
    {
      name: 'word insertion',
      oldMarkdown: 'Hello world',
      newMarkdown: 'Hello beautiful world',
      expectedDiffOps: [
        { type: 'delete', text: 'Hello world' },
        { type: 'insert', text: 'Hello beautiful world' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'word deletion',
      oldMarkdown: 'Hello beautiful world',
      newMarkdown: 'Hello world',
      expectedDiffOps: [
        { type: 'delete', text: 'Hello beautiful world' },
        { type: 'insert', text: 'Hello world' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'whitespace and multiline markdown',
      oldMarkdown: '# Heading\n\n  First paragraph.  \n\tSecond line.\n',
      newMarkdown: '# Heading\n\n  Updated paragraph!  \n\tSecond line.\n',
      expectedDiffOps: [
        { type: 'equal', text: '# Heading\n\n' },
        { type: 'delete', text: '  First paragraph.  \n' },
        { type: 'insert', text: '  Updated paragraph!  \n' },
        { type: 'equal', text: '\tSecond line.\n' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'literal HTML and punctuation in code',
      oldMarkdown: '```html\n<div title="old">Hello & goodbye.</div>\n```',
      newMarkdown: '```html\n<div title="new">Hello, world!</div>\n```',
      expectedDiffOps: [
        { type: 'equal', text: '```html\n' },
        { type: 'delete', text: '<div title="old">Hello & goodbye.</div>\n' },
        { type: 'insert', text: '<div title="new">Hello, world!</div>\n' },
        { type: 'equal', text: '```' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
  ] as const)('diffs $name into whole renderable Markdown documents', ({
    oldMarkdown, newMarkdown, expectedDiffOps, expectedDocuments,
  }) => {
    const diffOps = computeMarkdownDiff(oldMarkdown, newMarkdown);
    expect(diffOps).toEqual(expectedDiffOps);
    // Each side renders as a complete document so block context such as code fences survives.
    expect(buildMarkdownDiffDocuments(diffOps)).toEqual(expectedDocuments.map(type => ({
      type,
      markdown: type === 'delete' ? oldMarkdown : newMarkdown,
    })));
  });
});
