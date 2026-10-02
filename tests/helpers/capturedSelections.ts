export const capturedSelections = {
  selections: [
    { kind: 'editor' as const, selection: { mode: 'selection' as const, notePath: 'same.md', selectedText: 'first editor' } },
    { kind: 'browser' as const, selection: { source: 'browser', selectedText: 'first browser' } },
    { kind: 'canvas' as const, selection: { canvasPath: 'same.canvas', nodeIds: ['first-node'] } },
    { kind: 'editor' as const, selection: { mode: 'selection' as const, notePath: 'same.md', selectedText: 'second editor' } },
    { kind: 'browser' as const, selection: { source: 'browser', selectedText: 'second browser' } },
    { kind: 'canvas' as const, selection: { canvasPath: 'same.canvas', nodeIds: ['second-node'] } },
  ],
};

export const capturedSelectionPrompt = [
  '<editor_selection path="same.md">\n<![CDATA[first editor]]>\n</editor_selection>',
  '<browser_selection source="browser">\n<![CDATA[first browser]]>\n</browser_selection>',
  '<canvas_selection path="same.canvas">\n<![CDATA[first-node]]>\n</canvas_selection>',
  '<editor_selection path="same.md">\n<![CDATA[second editor]]>\n</editor_selection>',
  '<browser_selection source="browser">\n<![CDATA[second browser]]>\n</browser_selection>',
  '<canvas_selection path="same.canvas">\n<![CDATA[second-node]]>\n</canvas_selection>',
].join('\n\n');
