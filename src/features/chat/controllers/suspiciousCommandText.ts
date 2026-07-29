/**
 * Detects invisible, control, and bidirectional-spoofing characters in a
 * command string so the approval UI can warn before the user approves.
 *
 * This is a provider-independent display safeguard only. It does not parse or
 * interpret shell syntax and never changes what gets executed; it simply flags
 * text whose visible rendering may not match its actual bytes.
 */

export const SUSPICIOUS_COMMAND_WARNING =
  'This command contains invisible or bidirectional control characters. Review the command carefully.';

export function hasSuspiciousCommandText(text: string): boolean {
  return Array.from(text).some(isSuspiciousCommandCharacter);
}

export function isSuspiciousCommandCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }

  return (
    codePoint <= 0x08 // C0 controls (excluding tab/newline/carriage return)
    || codePoint === 0x0b
    || codePoint === 0x0c
    || (codePoint >= 0x0e && codePoint <= 0x1f)
    || (codePoint >= 0x7f && codePoint <= 0x9f) // DEL + C1 controls
    || codePoint === 0x061c // Arabic letter mark
    || (codePoint >= 0x200b && codePoint <= 0x200f) // zero-width + LRM/RLM
    || (codePoint >= 0x202a && codePoint <= 0x202e) // bidi embeddings/overrides
    || codePoint === 0x2060 // word joiner
    || (codePoint >= 0x2066 && codePoint <= 0x2069) // bidi isolates
    || codePoint === 0xfeff // zero-width no-break space / BOM
  );
}
