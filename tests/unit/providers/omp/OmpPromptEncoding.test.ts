import { buildOmpPrompt } from '@/providers/omp/execution/OmpExecutionSession';

describe('OMP prompt encoding', () => {
  it('includes the current note and editor selection in the ACP prompt', () => {
    expect(buildOmpPrompt({
      context: {
        currentNote: { path: 'Projects/OMP.md' },
        editorSelection: {
          lineCount: 2,
          mode: 'selection',
          notePath: 'Projects/OMP.md',
          selectedText: 'first line\nsecond line',
          startLine: 8,
        },
      },
      input: [{ text: 'Explain this', type: 'text' }],
    } as never)).toEqual([{
      text: `Explain this\n\n<linked_note path="Projects/OMP.md" />\n\n<editor_selection path="Projects/OMP.md" lines="8-9">\n<![CDATA[first line\nsecond line]]>\n</editor_selection>`,
      type: 'text',
    }]);
  });

  it('includes attached file chips in the ACP prompt', () => {
    expect(buildOmpPrompt({
      context: { contextFiles: ['notes/design.md'] },
      input: [{ text: 'Use this file', type: 'text' }],
    } as never)).toEqual([{
      text: 'Use this file\n\n<context_files>\n<context_file path="notes/design.md" />\n</context_files>',
      type: 'text',
    }]);
  });
});
