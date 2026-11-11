/**
 * Appends a raw unsent suffix to a restored draft prefix, keeping the suffix bytes intact.
 * Nonblank prefixes are separated from the suffix by at least two newlines.
 */
export function appendRawDraftSuffix(prefix: string, suffix: string): string {
  if (!suffix.trim()) return prefix;
  if (!prefix.trim()) return suffix;
  const separator = prefix.endsWith('\n\n') ? '' : prefix.endsWith('\n') ? '\n' : '\n\n';
  return prefix + separator + suffix;
}
