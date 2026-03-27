import type { ChatTurnRequest } from '@/core/runtime/types';
import { encodeCodexTurn } from '@/providers/codex/prompt/encodeCodexTurn';

describe('encodeCodexTurn', () => {
  it('should encode a basic text request', () => {
    const request: ChatTurnRequest = { text: 'Hello world' };
    const result = encodeCodexTurn(request);

    expect(result.prompt).toBe('Hello world');
    expect(result.persistedContent).toBe('Hello world');
    expect(result.isCompact).toBe(false);
    expect(result.mcpMentions.size).toBe(0);
    expect(result.request).toBe(request);
  });

  it('should include current note context', () => {
    const request: ChatTurnRequest = {
      text: 'Fix this',
      currentNotePath: 'notes/todo.md',
    };
    const result = encodeCodexTurn(request);

    expect(result.prompt).toContain('[Current note: notes/todo.md]');
    expect(result.persistedContent).toBe('Fix this');
  });

  it('should include editor selection context', () => {
    const request: ChatTurnRequest = {
      text: 'Explain this',
      editorSelection: {
        notePath: 'src/main.ts',
        mode: 'selection',
        selectedText: 'const x = 42;',
      },
    };
    const result = encodeCodexTurn(request);

    expect(result.prompt).toContain('[Editor selection from src/main.ts:');
    expect(result.prompt).toContain('const x = 42;');
  });

  it('should use "current note" fallback when editor selection has default notePath', () => {
    const request: ChatTurnRequest = {
      text: 'Explain this',
      editorSelection: {
        notePath: '',
        mode: 'selection',
        selectedText: 'some text',
      },
    };
    const result = encodeCodexTurn(request);

    expect(result.prompt).toContain('[Editor selection from current note:');
  });

  it('should include browser selection context', () => {
    const request: ChatTurnRequest = {
      text: 'Summarize',
      browserSelection: {
        source: 'chrome',
        selectedText: 'Article content here',
        url: 'https://example.com',
      },
    };
    const result = encodeCodexTurn(request);

    expect(result.prompt).toContain('[Browser selection from https://example.com:');
    expect(result.prompt).toContain('Article content here');
  });

  it('should include canvas selection context', () => {
    const request: ChatTurnRequest = {
      text: 'Review',
      canvasSelection: {
        canvasPath: 'my-canvas.canvas',
        nodeIds: ['node1', 'node2'],
      },
    };
    const result = encodeCodexTurn(request);

    expect(result.prompt).toContain('[Canvas selection from my-canvas.canvas:');
    expect(result.prompt).toContain('node1, node2');
  });

  it('should combine all context sections', () => {
    const request: ChatTurnRequest = {
      text: 'Do something',
      currentNotePath: 'note.md',
      editorSelection: { notePath: 'note.md', mode: 'selection', selectedText: 'selected' },
      browserSelection: { source: 'chrome', selectedText: 'browser' },
      canvasSelection: { canvasPath: 'c.canvas', nodeIds: ['n1'] },
    };
    const result = encodeCodexTurn(request);

    expect(result.prompt).toContain('Do something');
    expect(result.prompt).toContain('[Current note: note.md]');
    expect(result.prompt).toContain('[Editor selection');
    expect(result.prompt).toContain('[Browser selection');
    expect(result.prompt).toContain('[Canvas selection');
  });

  it('should not include empty editor selection', () => {
    const request: ChatTurnRequest = {
      text: 'Hello',
      editorSelection: { notePath: 'note.md', mode: 'none', selectedText: '' },
    };
    const result = encodeCodexTurn(request);

    expect(result.prompt).toBe('Hello');
  });

  it('should not include canvas selection with empty nodeIds', () => {
    const request: ChatTurnRequest = {
      text: 'Hello',
      canvasSelection: { canvasPath: 'c.canvas', nodeIds: [] },
    };
    const result = encodeCodexTurn(request);

    expect(result.prompt).toBe('Hello');
  });
});
