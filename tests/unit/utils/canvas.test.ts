import { appendCanvasContext, type CanvasSelectionContext } from '../../../src/utils/canvas';

describe('canvas utilities', () => {
  it('formats multiple node selection as comma-separated list', () => {
    const context: CanvasSelectionContext = {
      canvasPath: 'folder/design.canvas',
      nodeIds: ['node1', 'node2', 'node3'],
    };
    expect(appendCanvasContext('Prompt', context)).toBe(
      'Prompt\n\n<canvas_selection path="folder/design.canvas">\n<![CDATA[node1, node2, node3]]>\n</canvas_selection>'
    );
  });

  it('escapes the canvas path and a conflicting closing tag', () => {
    const context: CanvasSelectionContext = {
      canvasPath: 'folder/my "canvas" & draft.canvas',
      nodeIds: ['before', '</canvas_selection>'],
    };
    expect(appendCanvasContext('Prompt', context)).toBe(
      'Prompt\n\n<canvas_selection path="folder/my &quot;canvas&quot; &amp; draft.canvas">\n<![CDATA[before, </canvas_selection>]]>\n</canvas_selection>',
    );
  });

  it('appends canvas context after prompt with double newline', () => {
    const context: CanvasSelectionContext = {
      canvasPath: 'my-canvas.canvas',
      nodeIds: ['abc123'],
    };
    const result = appendCanvasContext('hello world', context);
    expect(result).toBe(
      'hello world\n\n<canvas_selection path="my-canvas.canvas">\n<![CDATA[abc123]]>\n</canvas_selection>'
    );
  });

  it('returns original prompt when no nodes selected', () => {
    const context: CanvasSelectionContext = {
      canvasPath: 'my-canvas.canvas',
      nodeIds: [],
    };
    expect(appendCanvasContext('hello world', context)).toBe('hello world');
  });
});
