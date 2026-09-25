import {
  appendEditorContext,
  buildCursorContext,
  type EditorSelectionContext,
  formatEditorContext,
} from '@/utils/editor';

function makeGetLine(lines: string[]): (line: number) => string {
  return (line: number) => lines[line] ?? '';
}

describe('buildCursorContext', () => {
  it('splits line at cursor position', () => {
    const lines = ['hello world'];
    const result = buildCursorContext(makeGetLine(lines), lines.length, 0, 5);
    expect(result.beforeCursor).toBe('hello');
    expect(result.afterCursor).toBe(' world');
    expect(result.isInbetween).toBe(false);
    expect(result.line).toBe(0);
    expect(result.column).toBe(5);
  });

  it.each([
    { label: 'start', lines: ['', 'next line'], line: 0, before: '', after: 'next line' },
    { label: 'end', lines: ['previous line', ''], line: 1, before: 'previous line', after: '' },
  ])('cursor on an empty line at the $label of the document', ({ lines, line, before, after }) => {
    const result = buildCursorContext(makeGetLine(lines), lines.length, line, 0);
    expect(result.isInbetween).toBe(true);
    expect(result.beforeCursor).toBe(before);
    expect(result.afterCursor).toBe(after);
  });

  it('cursor on empty line between content', () => {
    const lines = ['above', '', 'below'];
    const result = buildCursorContext(makeGetLine(lines), lines.length, 1, 0);
    expect(result.isInbetween).toBe(true);
    expect(result.beforeCursor).toBe('above');
    expect(result.afterCursor).toBe('below');
  });

  it('cursor on whitespace-only line', () => {
    const lines = ['above', '   ', '', '  \t  ', '', ' \t ', 'below'];
    const result = buildCursorContext(makeGetLine(lines), lines.length, 3, 1);
    expect(result.isInbetween).toBe(true);
    expect(result.beforeCursor).toBe('above');
    expect(result.afterCursor).toBe('below');
  });

  it('cursor at end of non-empty line is not inbetween', () => {
    const lines = ['hello'];
    const result = buildCursorContext(makeGetLine(lines), lines.length, 0, 5);
    expect(result.isInbetween).toBe(false);
    expect(result.beforeCursor).toBe('hello');
    expect(result.afterCursor).toBe('');
  });

  it('cursor in middle of word', () => {
    const lines = ['function test() {}'];
    const result = buildCursorContext(makeGetLine(lines), lines.length, 0, 8);
    expect(result.beforeCursor).toBe('function');
    expect(result.afterCursor).toBe(' test() {}');
    expect(result.isInbetween).toBe(false);
  });
});

describe('formatEditorContext', () => {
  it('formats selection context', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'selection',
      selectedText: 'selected content',
      startLine: 5,
      lineCount: 3,
    };
    const result = formatEditorContext(context);
    expect(result).toBe('<editor_selection path="test.md" lines="5-7">\n<![CDATA[selected content]]>\n</editor_selection>');
  });

  it('formats selection without line info', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'selection',
      selectedText: 'selected',
    };
    const result = formatEditorContext(context);
    expect(result).toBe('<editor_selection path="test.md">\n<![CDATA[selected]]>\n</editor_selection>');
  });

  it('escapes the note path and a conflicting closing tag', () => {
    const context: EditorSelectionContext = {
      notePath: 'notes/my "file" & draft.md',
      mode: 'selection',
      selectedText: 'before\n</editor_selection>\nafter',
    };

    expect(formatEditorContext(context)).toBe(
      '<editor_selection path="notes/my &quot;file&quot; &amp; draft.md">\n<![CDATA[before\n</editor_selection>\nafter]]>\n</editor_selection>',
    );
  });

  it('formats inline cursor context', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'cursor',
      cursorContext: {
        beforeCursor: 'hello',
        afterCursor: ' world',
        isInbetween: false,
        line: 0,
        column: 5,
      },
    };
    const result = formatEditorContext(context);
    expect(result).toBe('<editor_cursor path="test.md">\n<![CDATA[hello| world #inline]]>\n</editor_cursor>');
  });

  it('formats inbetween cursor context', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'cursor',
      cursorContext: {
        beforeCursor: 'above',
        afterCursor: 'below',
        isInbetween: true,
        line: 1,
        column: 0,
      },
    };
    const result = formatEditorContext(context);
    expect(result).toBe('<editor_cursor path="test.md">\n<![CDATA[above\n| #inbetween\nbelow]]>\n</editor_cursor>');
  });

  it('formats inbetween cursor with no before content', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'cursor',
      cursorContext: {
        beforeCursor: '',
        afterCursor: 'below',
        isInbetween: true,
        line: 0,
        column: 0,
      },
    };
    const result = formatEditorContext(context);
    expect(result).toBe('<editor_cursor path="test.md">\n<![CDATA[| #inbetween\nbelow]]>\n</editor_cursor>');
  });

  it('formats inbetween cursor with no after content', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'cursor',
      cursorContext: {
        beforeCursor: 'above',
        afterCursor: '',
        isInbetween: true,
        line: 5,
        column: 0,
      },
    };
    const result = formatEditorContext(context);
    expect(result).toBe('<editor_cursor path="test.md">\n<![CDATA[above\n| #inbetween]]>\n</editor_cursor>');
  });

  it('formats inbetween cursor with no before and no after content', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'cursor',
      cursorContext: {
        beforeCursor: '',
        afterCursor: '',
        isInbetween: true,
        line: 0,
        column: 0,
      },
    };
    const result = formatEditorContext(context);
    expect(result).toBe('<editor_cursor path="test.md">\n<![CDATA[| #inbetween]]>\n</editor_cursor>');
  });

  it('returns empty string for none mode', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'none',
    };
    expect(formatEditorContext(context)).toBe('');
  });

  it('returns empty string for selection mode without selectedText', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'selection',
    };
    expect(formatEditorContext(context)).toBe('');
  });

  it('returns empty string for cursor mode without cursorContext', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'cursor',
    };
    expect(formatEditorContext(context)).toBe('');
  });
});

describe('appendEditorContext', () => {
  it('appends formatted context to prompt', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'selection',
      selectedText: 'text',
      startLine: 1,
      lineCount: 1,
    };
    const result = appendEditorContext('Fix this', context);
    expect(result).toBe('Fix this\n\n<editor_selection path="test.md" lines="1-1">\n<![CDATA[text]]>\n</editor_selection>');
  });

  it('returns prompt unchanged when context is none', () => {
    const context: EditorSelectionContext = {
      notePath: 'test.md',
      mode: 'none',
    };
    expect(appendEditorContext('Fix this', context)).toBe('Fix this');
  });
});
