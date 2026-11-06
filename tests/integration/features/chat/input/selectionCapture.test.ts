import { capturedSelectionPrompt, capturedSelections } from '@test/helpers/capturedSelections';

import { appendExecutionContext } from '@/core/prompt/promptContext';
import { ComposerSelections, type ComposerSelectionSources } from '@/features/chat/input/ComposerSelections';
import { captureSelectionSnapshots } from '@/features/chat/state/chatTurnRequest';

function createSources() {
  return {
    editor: { start: vi.fn(), stop: vi.fn(), poll: vi.fn(), getContext: vi.fn(() => null) },
    browser: { poll: vi.fn(async () => undefined), clear: vi.fn(), getContext: vi.fn(() => null) },
    canvas: { poll: vi.fn(), clear: vi.fn(), getContext: vi.fn(() => null) },
  } satisfies ComposerSelectionSources;
}

describe('ComposerSelections capture', () => {
  it('owns nested cursor and canvas data after capture', () => {
    const editor = { mode: 'cursor' as const, notePath: 'same.md', cursorContext: {
      beforeCursor: 'before', afterCursor: 'after', isInbetween: false, line: 0, column: 6,
    } };
    const canvas = { canvasPath: 'same.canvas', nodeIds: ['captured-node'] };
    const sources = createSources();
    const selections = new ComposerSelections({
      ...sources,
      editor: { ...sources.editor, getContext: () => editor },
      canvas: { ...sources.canvas, getContext: () => canvas },
    });

    const captured = selections.capture();
    editor.cursorContext.beforeCursor = 'changed';
    canvas.nodeIds.push('later-node');
    const prompt = appendExecutionContext('Question', { selections: captureSelectionSnapshots(captured) });
    expect(prompt).toContain('before|after');
    expect(prompt).toContain('captured-node');
    expect(prompt).not.toContain('changed');
    expect(prompt).not.toContain('later-node');
  });
});

describe('captureSelectionSnapshots', () => {
  it('gives ordered captures precedence over singular composer fields', () => {
    const selections = captureSelectionSnapshots({
      ...capturedSelections,
      editorSelection: { mode: 'selection', notePath: 'legacy.md', selectedText: 'legacy duplicate' },
    });
    expect(appendExecutionContext('Question', { selections })).toBe('Question\n\n' + capturedSelectionPrompt);
  });

  it('normalizes singular fields but respects an explicitly empty ordered capture', () => {
    const legacy = { editorSelection: { mode: 'selection' as const, notePath: 'same.md', selectedText: 'first editor' } };
    expect(appendExecutionContext('Question', { selections: captureSelectionSnapshots(legacy) }))
      .toBe('Question\n\n' + capturedSelectionPrompt.split('\n\n')[0]);
    expect(captureSelectionSnapshots({ ...legacy, selections: [] })).toEqual([]);
  });

});
