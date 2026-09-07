import { parseConflictTextMerge } from '@/app/collab/conflicts/ConflictTextMerge';

const MARKERS = {
  acceptedLabel: 'ACCEPTED',
  baseLabel: 'BASE',
  markerSize: 7,
  personalLabel: 'PERSONAL',
};

describe('parseConflictTextMerge', () => {
  it('projects multiple Git diff3 conflicts while preserving common text', () => {
    expect(parseConflictTextMerge([
      'before\n',
      '<<<<<<< PERSONAL\n',
      'personal one\n',
      '||||||| BASE\n',
      'base one\n',
      '=======\n',
      'accepted one\n',
      '>>>>>>> ACCEPTED\n',
      'middle\n',
      '<<<<<<< PERSONAL\n',
      'personal two\n',
      '||||||| BASE\n',
      'base two\n',
      '=======\n',
      'accepted two\n',
      '>>>>>>> ACCEPTED\n',
      'after\n',
    ].join(''), MARKERS)).toEqual([
      { kind: 'common', text: 'before\n' },
      {
        accepted: 'accepted one\n',
        base: 'base one\n',
        id: 'hunk-1',
        kind: 'conflict',
        personal: 'personal one\n',
      },
      { kind: 'common', text: 'middle\n' },
      {
        accepted: 'accepted two\n',
        base: 'base two\n',
        id: 'hunk-2',
        kind: 'conflict',
        personal: 'personal two\n',
      },
      { kind: 'common', text: 'after\n' },
    ]);
  });

  it('rejects incomplete or conflict-free marker output', () => {
    expect(() => parseConflictTextMerge('ordinary\n', MARKERS)).toThrow();
    expect(() => parseConflictTextMerge([
      '<<<<<<< PERSONAL\n',
      'personal\n',
      '||||||| BASE\n',
      'base\n',
    ].join(''), MARKERS)).toThrow();
  });
});
