const INTERRUPT_MARKERS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

const COMPACTION_CANCELED_STDERR_PATTERN =
  /^<local-command-stderr>\s*Error:\s*Compaction canceled\.?\s*<\/local-command-stderr>$/i;

const INTERRUPT_INDICATOR_HTML_VARIANTS = [
  '<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Oh My Claudian do instead?</span>',
  '<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>',
];

function normalize(text: string): string {
  return text.trim();
}

export function isBracketInterruptText(text: string): boolean {
  return INTERRUPT_MARKERS.has(normalize(text));
}

export function isCompactionCanceledStderr(text: string): boolean {
  return COMPACTION_CANCELED_STDERR_PATTERN.test(normalize(text));
}

export function isInterruptSignalText(text: string): boolean {
  return isBracketInterruptText(text) || isCompactionCanceledStderr(text);
}

export function stripLegacyInterruptIndicator(text: string): {
  content: string;
  interrupted: boolean;
} {
  const markerMatch = INTERRUPT_INDICATOR_HTML_VARIANTS
    .map(marker => ({ marker, index: text.lastIndexOf(marker) }))
    .sort((left, right) => right.index - left.index)[0];
  if (
    !markerMatch
    || markerMatch.index === -1
    || text.slice(markerMatch.index + markerMatch.marker.length).trim().length > 0
  ) {
    return { content: text, interrupted: false };
  }

  return {
    content: text.slice(0, markerMatch.index).trimEnd(),
    interrupted: true,
  };
}
