import type { ChatTurnRequest } from '@/core/runtime/types';
import { encodeClaudeTurn } from '@/providers/claude/prompt/ClaudeTurnEncoder';

function createMockMcpManager() {
  return {
    extractMentions: jest.fn().mockReturnValue(new Set<string>()),
    transformMentions: jest.fn().mockImplementation((text: string) => text),
  };
}

describe('encodeClaudeTurn', () => {
  let mcpManager: ReturnType<typeof createMockMcpManager>;

  beforeEach(() => {
    mcpManager = createMockMcpManager();
  });

  it('should return PreparedChatTurn with correct shape', () => {
    const request: ChatTurnRequest = { text: 'hello' };
    const result = encodeClaudeTurn(request, mcpManager);

    expect(result).toEqual({
      request,
      persistedContent: 'hello',
      prompt: 'hello',
      isCompact: false,
      mcpMentions: new Set(),
    });
  });

  it('should detect /compact command', () => {
    const result = encodeClaudeTurn({ text: '/compact' }, mcpManager);
    expect(result.isCompact).toBe(true);
  });

  it('should detect /compact with arguments', () => {
    const result = encodeClaudeTurn({ text: '/compact summarize' }, mcpManager);
    expect(result.isCompact).toBe(true);
  });

  it('should not treat "compact" without slash as compact', () => {
    const result = encodeClaudeTurn({ text: 'compact this' }, mcpManager);
    expect(result.isCompact).toBe(false);
  });

  it('should skip all context appending when /compact', () => {
    const request: ChatTurnRequest = {
      text: '/compact',
      currentNotePath: 'notes/test.md',
      editorSelection: { notePath: 'test.md', mode: 'selection', selectedText: 'selected' } as any,
      browserSelection: { source: 'surfing-view', selectedText: 'browser text' } as any,
    };
    const result = encodeClaudeTurn(request, mcpManager);

    expect(result.persistedContent).toBe('/compact');
    expect(result.prompt).toBe('/compact');
  });

  it('should append current note context', () => {
    const request: ChatTurnRequest = {
      text: 'hello',
      currentNotePath: 'notes/test.md',
    };
    const result = encodeClaudeTurn(request, mcpManager);

    expect(result.persistedContent).toContain('<current_note>');
    expect(result.persistedContent).toContain('notes/test.md');
  });

  it('should append editor selection context', () => {
    const request: ChatTurnRequest = {
      text: 'explain this',
      editorSelection: {
        notePath: 'notes/test.md',
        mode: 'selection',
        selectedText: 'selected code',
      } as any,
    };
    const result = encodeClaudeTurn(request, mcpManager);

    expect(result.persistedContent).toContain('<editor_selection');
    expect(result.persistedContent).toContain('selected code');
  });

  it('should append browser selection context', () => {
    const request: ChatTurnRequest = {
      text: 'summarize',
      browserSelection: {
        source: 'surfing-view',
        selectedText: 'browser text',
        title: 'Test Page',
      } as any,
    };
    const result = encodeClaudeTurn(request, mcpManager);

    expect(result.persistedContent).toContain('<browser_selection');
    expect(result.persistedContent).toContain('browser text');
  });

  it('should append canvas selection context', () => {
    const request: ChatTurnRequest = {
      text: 'explain this canvas',
      canvasSelection: {
        canvasPath: 'diagrams/overview.canvas',
        nodeIds: ['node-1', 'node-2'],
      } as any,
    };
    const result = encodeClaudeTurn(request, mcpManager);

    expect(result.persistedContent).toContain('<canvas_selection');
    expect(result.persistedContent).toContain('diagrams/overview.canvas');
    expect(result.persistedContent).toContain('node-1');
    expect(result.persistedContent).toContain('node-2');
  });

  it('should extract and transform MCP mentions', () => {
    const mentions = new Set(['server-a']);
    mcpManager.extractMentions.mockReturnValue(mentions);
    mcpManager.transformMentions.mockImplementation((text: string) => text + ' [transformed]');

    const result = encodeClaudeTurn({ text: '@server-a hello' }, mcpManager);

    expect(mcpManager.extractMentions).toHaveBeenCalledWith(result.persistedContent);
    expect(result.mcpMentions).toBe(mentions);
    expect(result.prompt).toContain('[transformed]');
    // persistedContent should NOT have the transformation
    expect(result.persistedContent).not.toContain('[transformed]');
  });

  it('should handle request with no optional fields', () => {
    const result = encodeClaudeTurn({ text: 'plain message' }, mcpManager);

    expect(result.persistedContent).toBe('plain message');
    expect(result.prompt).toBe('plain message');
    expect(result.isCompact).toBe(false);
    expect(result.request.text).toBe('plain message');
  });

  it('should preserve request reference in output', () => {
    const request: ChatTurnRequest = { text: 'hello', images: [{ mediaType: 'image/png', data: 'abc' }] as any };
    const result = encodeClaudeTurn(request, mcpManager);

    expect(result.request).toBe(request);
  });
});
