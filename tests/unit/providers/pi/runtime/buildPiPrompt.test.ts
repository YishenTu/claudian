import {
  buildPiPromptImages,
  buildPiPromptText,
} from '@/providers/pi/runtime/buildPiPrompt';

describe('buildPiPrompt', () => {
  it('appends provider-neutral note and selection context without embedding images', () => {
    const prompt = buildPiPromptText({
      browserSelection: {
        selectedText: 'Browser text',
        source: 'browser',
        title: 'Docs',
        url: 'https://example.com',
      },
      canvasSelection: {
        canvasPath: 'Board.canvas',
        nodeIds: ['node-a', 'node-b'],
      },
      currentNotePath: 'Notes/today.md',
      editorSelection: {
        lineCount: 2,
        mode: 'selection',
        notePath: 'Notes/today.md',
        selectedText: 'Selected text',
        startLine: 4,
      },
      images: [{
        data: 'base64-image',
        id: 'image-1',
        mediaType: 'image/png',
        name: 'image.png',
        size: 12,
        source: 'paste',
      }],
      text: 'Summarize this',
    });

    expect(prompt).toContain('Summarize this');
    expect(prompt).toContain('<current_note>\nNotes/today.md\n</current_note>');
    expect(prompt).toContain('<editor_selection path="Notes/today.md" lines="4-5">\nSelected text\n</editor_selection>');
    expect(prompt).toContain('<browser_selection source="browser" title="Docs" url="https://example.com">\nBrowser text\n</browser_selection>');
    expect(prompt).toContain('<canvas_selection path="Board.canvas">\nnode-a, node-b\n</canvas_selection>');
    expect(prompt).not.toContain('base64-image');
  });

  it('uses history context only when conversation history is supplied', () => {
    const withoutHistory = buildPiPromptText({ text: 'Continue' });
    const withHistory = buildPiPromptText({ text: 'Continue' }, [
      {
        content: 'Earlier request',
        id: 'm1',
        role: 'user',
        timestamp: 1,
      },
    ]);

    expect(withoutHistory).toBe('Continue');
    expect(withHistory).toContain('Earlier request');
    expect(withHistory).toContain('Continue');
  });

  it('maps image attachments separately for Pi RPC payloads', () => {
    expect(buildPiPromptImages([
      {
        data: 'image-a',
        id: 'image-a',
        mediaType: 'image/png',
        name: 'a.png',
        size: 12,
        source: 'paste',
      },
      {
        data: '',
        id: 'image-b',
        mediaType: 'image/jpeg',
        name: 'b.jpg',
        size: 12,
        source: 'paste',
      },
    ])).toEqual([
      { data: 'image-a', mimeType: 'image/png', type: 'image' },
    ]);
  });
});
