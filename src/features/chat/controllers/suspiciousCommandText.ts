/**
 * Detects invisible, control, and bidirectional-spoofing characters in a
 * command string so the approval UI can warn before the user approves.
 *
 * This is a display safeguard only. It never parses shell syntax or changes
 * what gets executed.
 */
export const SUSPICIOUS_COMMAND_WARNING =
  'This command contains invisible or bidirectional control characters. Review the command carefully.';

export function hasSuspiciousCommandText(text: string): boolean {
  return Array.from(text).some(isSuspiciousCommandCharacter);
}

export function isSuspiciousCommandCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;

  return (
    codePoint <= 0x08
    || codePoint === 0x0b
    || codePoint === 0x0c
    || (codePoint >= 0x0e && codePoint <= 0x1f)
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x061c
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || codePoint === 0x2060
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
    || codePoint === 0xfeff
  );
}
