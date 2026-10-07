import { parseCompactCommand } from '@/core/commands/compactCommand';

describe('parseCompactCommand', () => {
  it.each([
    ['/compact', ''],
    [' \t/CoMpAcT\n ', ''],
    ['/compact keep recent edits', 'keep recent edits'],
    ['/compact\n\nkeep recent edits\n  and tests  ', 'keep recent edits\n  and tests'],
  ])('recognizes %j and preserves explicit instructions', (text, instructions) => {
    expect(parseCompactCommand(text)).toEqual({ instructions });
  });

  it.each(['', '  ', '/compactly', '/compact-more', '/compact/path', 'Explain /compact', 'History\n/compact'])(
    'leaves ordinary input %j unchanged', text => {
      expect(parseCompactCommand(text)).toBeNull();
    },
  );
});
