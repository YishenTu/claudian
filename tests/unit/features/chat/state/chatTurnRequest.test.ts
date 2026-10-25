import { capturedSelectionPrompt, capturedSelections } from '@test/helpers/capturedSelections';

import { appendExecutionContext } from '@/core/prompt/promptContext';
import { captureSelectionSnapshots } from '@/features/chat/state/chatTurnRequest';

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
