import { isCancelPhrase } from '../../../src/features/voice/voiceCommands';

describe('isCancelPhrase', () => {
  it('matches bare cancel phrases', () => {
    expect(isCancelPhrase('cancel')).toBe(true);
    expect(isCancelPhrase('scratch that')).toBe(true);
    expect(isCancelPhrase('never mind')).toBe(true);
    expect(isCancelPhrase('nevermind')).toBe(true);
    expect(isCancelPhrase('stop that')).toBe(true);
    expect(isCancelPhrase('forget it')).toBe(true);
    expect(isCancelPhrase('discard')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isCancelPhrase('  CANCEL  ')).toBe(true);
    expect(isCancelPhrase('Scratch   That')).toBe(true);
  });

  it('ignores trailing punctuation', () => {
    expect(isCancelPhrase('cancel.')).toBe(true);
    expect(isCancelPhrase('never mind!')).toBe(true);
  });

  it('does not match when the phrase is part of a real instruction', () => {
    expect(isCancelPhrase('cancel the deploy')).toBe(false);
    expect(isCancelPhrase('discard the local changes')).toBe(false);
    expect(isCancelPhrase('stop that service and restart it')).toBe(false);
  });

  it('returns false for empty or unrelated input', () => {
    expect(isCancelPhrase('')).toBe(false);
    expect(isCancelPhrase('   ')).toBe(false);
    expect(isCancelPhrase('refactor the parser')).toBe(false);
  });
});
