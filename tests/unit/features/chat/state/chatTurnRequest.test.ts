import { capturedSelectionPrompt, capturedSelections } from '@test/helpers/capturedSelections';

import { appendSelectionContexts } from '@/core/prompt/promptContext';
import { captureSelectionSnapshots } from '@/features/chat/state/chatTurnRequest';

describe('captureSelectionSnapshots', () => {
  it('gives ordered captures precedence over singular composer fields', () => {
    const selections = captureSelectionSnapshots({
      ...capturedSelections,
      editorSelection: { mode: 'selection', notePath: 'legacy.md', selectedText: 'legacy duplicate' },
    });
    expect(appendSelectionContexts('Question', { selections })).toBe('Question\n\n' + capturedSelectionPrompt);
  });

  it('normalizes singular fields but respects an explicitly empty ordered capture', () => {
    const legacy = { editorSelection: { mode: 'selection' as const, notePath: 'same.md', selectedText: 'first editor' } };
    expect(appendSelectionContexts('Question', { selections: captureSelectionSnapshots(legacy) }))
      .toBe('Question\n\n' + capturedSelectionPrompt.split('\n\n')[0]);
    expect(captureSelectionSnapshots({ ...legacy, selections: [] })).toEqual([]);
  });

  it('owns nested cursor and canvas data after capture', () => {
    const context = {
      editorSelection: { mode: 'cursor' as const, notePath: 'same.md', cursorContext: {
        beforeCursor: 'before', afterCursor: 'after', isInbetween: false, line: 0, column: 6,
      } },
      canvasSelection: { canvasPath: 'same.canvas', nodeIds: ['captured-node'] },
    };
    const selections = captureSelectionSnapshots(context);
    context.editorSelection.cursorContext.beforeCursor = 'changed';
    context.canvasSelection.nodeIds.push('later-node');
    const prompt = appendSelectionContexts('Question', { selections });
    expect(prompt).toContain('before|after');
    expect(prompt).toContain('captured-node');
    expect(prompt).not.toContain('changed');
    expect(prompt).not.toContain('later-node');
  });
});
