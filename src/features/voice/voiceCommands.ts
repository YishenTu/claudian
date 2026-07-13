// Pure recognition of hands-free control phrases spoken during the confirm
// window. Kept side-effect-free (like speakable/sentences) so the matcher can be
// unit-tested without a bridge or DOM.
//
// The confirm window arms the mic after a command lands, so the very next
// transcript is either a cancel phrase (drop the pending command) or more
// speech (refine it). isCancelPhrase draws that line.

/**
 * Phrases that discard the pending voice command. Matched against the whole
 * normalized utterance — a cancel phrase said in isolation, not mid-sentence,
 * so "cancel the deploy" (a real instruction) still submits.
 */
const CANCEL_PHRASES: readonly string[] = [
  'cancel',
  'scratch that',
  'never mind',
  'nevermind',
  'stop that',
  'forget it',
  'discard',
];

/** Lower-case, collapse whitespace, and strip trailing punctuation for match. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the utterance is a bare cancel phrase (the entire thing, not a
 * substring). Requiring an exact match avoids cancelling on instructions that
 * merely contain the word — e.g. "cancel the subscription" is a command.
 */
export function isCancelPhrase(text: string): boolean {
  const normalized = normalize(text);
  if (normalized === '') {
    return false;
  }
  return CANCEL_PHRASES.includes(normalized);
}
