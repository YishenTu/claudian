// Pure helper for computing how a dictated transcript merges into the current
// input textarea value. Kept free of DOM/Obsidian types so the merge rule can
// be unit-tested directly; the DictationController owns the actual DOM writes.

/** The result of merging a dictated transcript into an existing input value. */
export interface DictationMerge {
  /** New full textarea value. */
  value: string;
  /** Caret position (character offset) after the inserted text. */
  caret: number;
}

/**
 * Merge a dictated transcript into `existing` at caret position `caret`.
 *
 * Rules (WHY): dictation should feel like typing at the cursor, so we splice at
 * the caret rather than always appending. A single space is inserted before the
 * transcript when the preceding character is non-whitespace, so consecutive
 * dictations don't run words together. Empty transcripts are the caller's
 * concern (ignored upstream); here an empty transcript is a no-op splice.
 */
export function mergeDictation(
  existing: string,
  transcript: string,
  caret: number,
): DictationMerge {
  const clampedCaret = Math.max(0, Math.min(caret, existing.length));
  const before = existing.slice(0, clampedCaret);
  const after = existing.slice(clampedCaret);

  // Add a joining space only when butting up against existing non-space text.
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const insertion = (needsLeadingSpace ? ' ' : '') + transcript;

  return {
    value: before + insertion + after,
    caret: before.length + insertion.length,
  };
}
