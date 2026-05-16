import type { ChatTurnRequest } from '@/core/runtime/types';
import { encodeCursorTurn } from '@/providers/cursor/prompt/encodeCursorTurn';

function buildRequest(overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest {
  return {
    text: 'hello',
    ...overrides,
  };
}

describe('encodeCursorTurn', () => {
  it('passes the prompt through verbatim when no context is attached', () => {
    const result = encodeCursorTurn(buildRequest({ text: 'hello world' }));
    expect(result.prompt).toBe('hello world');
    expect(result.persistedContent).toBe('hello world');
    expect(result.isCompact).toBe(false);
    expect(result.mcpMentions.size).toBe(0);
  });

  it('marks /compact commands as compact', () => {
    const result = encodeCursorTurn(buildRequest({ text: '/compact' }));
    expect(result.isCompact).toBe(true);
    expect(result.prompt).toBe('/compact');
  });

  it('appends the current note path when set', () => {
    const result = encodeCursorTurn(buildRequest({
      text: 'summarize',
      currentNotePath: 'notes/today.md',
    }));
    expect(result.prompt).toContain('summarize');
    expect(result.prompt).toContain('[Current note: notes/today.md]');
  });

  it('appends editor selection when present', () => {
    const result = encodeCursorTurn(buildRequest({
      text: 'fix this',
      editorSelection: {
        notePath: 'notes/code.md',
        mode: 'selection',
        selectedText: 'const x = 1',
      },
    }));
    expect(result.prompt).toContain('Editor selection from notes/code.md');
    expect(result.prompt).toContain('const x = 1');
  });

  it('appends browser selection when present', () => {
    const result = encodeCursorTurn(buildRequest({
      text: 'translate',
      browserSelection: {
        source: 'browser',
        url: 'https://example.com',
        selectedText: 'lorem ipsum',
      },
    }));
    expect(result.prompt).toContain('Browser selection from https://example.com');
    expect(result.prompt).toContain('lorem ipsum');
  });

  it('appends canvas selection when present', () => {
    const result = encodeCursorTurn(buildRequest({
      text: 'rearrange',
      canvasSelection: {
        canvasPath: 'canvases/board.canvas',
        nodeIds: ['node-a', 'node-b'],
      },
    }));
    expect(result.prompt).toContain('Canvas selection from canvases/board.canvas');
    expect(result.prompt).toContain('node-a, node-b');
  });
});
