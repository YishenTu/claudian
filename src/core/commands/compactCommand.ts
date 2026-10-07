/** Recognize raw user input before adding captured context or recovery history. */
export function parseCompactCommand(rawText: string): { instructions: string } | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/iu.exec(rawText.trim());
  return match ? { instructions: match[1]?.trim() ?? '' } : null;
}
