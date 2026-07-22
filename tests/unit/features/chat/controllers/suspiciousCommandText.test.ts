import {
  hasSuspiciousCommandText,
  isSuspiciousCommandCharacter,
} from '@/features/chat/controllers/suspiciousCommandText';

const cp = (codePoint: number): string => String.fromCodePoint(codePoint);

describe('suspiciousCommandText', () => {
  describe('isSuspiciousCommandCharacter', () => {
    it('flags C0 control characters (excluding tab/newline/carriage return)', () => {
      expect(isSuspiciousCommandCharacter(cp(0x00))).toBe(true);
      expect(isSuspiciousCommandCharacter(cp(0x08))).toBe(true);
      expect(isSuspiciousCommandCharacter(cp(0x1b))).toBe(true); // ESC
    });

    it('flags DEL and C1 control characters', () => {
      expect(isSuspiciousCommandCharacter(cp(0x7f))).toBe(true);
      expect(isSuspiciousCommandCharacter(cp(0x9f))).toBe(true);
    });

    it('flags zero-width, bidi, and BOM characters', () => {
      expect(isSuspiciousCommandCharacter(cp(0x200b))).toBe(true); // zero-width space
      expect(isSuspiciousCommandCharacter(cp(0x200e))).toBe(true); // LRM
      expect(isSuspiciousCommandCharacter(cp(0x202e))).toBe(true); // RLO
      expect(isSuspiciousCommandCharacter(cp(0x2066))).toBe(true); // LRI
      expect(isSuspiciousCommandCharacter(cp(0x061c))).toBe(true); // ALM
      expect(isSuspiciousCommandCharacter(cp(0x2060))).toBe(true); // word joiner
      expect(isSuspiciousCommandCharacter(cp(0xfeff))).toBe(true); // BOM
    });

    it('does not flag ordinary command characters or common whitespace', () => {
      for (const char of 'git commit -m "hello world" | grep foo\t\r\n') {
        expect(isSuspiciousCommandCharacter(char)).toBe(false);
      }
    });
  });

  describe('hasSuspiciousCommandText', () => {
    it('returns false for a normal command', () => {
      expect(hasSuspiciousCommandText('rm -rf ./build && npm run ship')).toBe(false);
    });

    it('returns true when a bidi override is hidden in the command', () => {
      expect(hasSuspiciousCommandText(`rm ${cp(0x202e)}harmless.txt`)).toBe(true);
    });

    it('returns true for an embedded zero-width space', () => {
      expect(hasSuspiciousCommandText(`npm${cp(0x200b)} install left-pad`)).toBe(true);
    });

    it('returns false for an empty string', () => {
      expect(hasSuspiciousCommandText('')).toBe(false);
    });
  });
});
