import {
  hasSuspiciousCommandText,
  isSuspiciousCommandCharacter,
} from '@/features/chat/controllers/suspiciousCommandText';

const cp = (codePoint: number): string => String.fromCodePoint(codePoint);

describe('suspiciousCommandText', () => {
  it('flags control, zero-width, and bidirectional characters', () => {
    for (const codePoint of [0x00, 0x1b, 0x7f, 0x9f, 0x061c, 0x200b, 0x202e, 0x2066, 0xfeff]) {
      expect(isSuspiciousCommandCharacter(cp(codePoint))).toBe(true);
    }
  });

  it('does not flag ordinary command characters or common whitespace', () => {
    for (const char of 'git commit -m "hello world" | grep foo\t\r\n') {
      expect(isSuspiciousCommandCharacter(char)).toBe(false);
    }
  });

  it('detects hidden characters embedded in a command', () => {
    expect(hasSuspiciousCommandText(`rm ${cp(0x202e)}harmless.txt`)).toBe(true);
    expect(hasSuspiciousCommandText('rm -rf ./build && npm run ship')).toBe(false);
  });
});
