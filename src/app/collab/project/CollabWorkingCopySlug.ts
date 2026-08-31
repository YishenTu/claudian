/** Application-owned portable directory grammar, not a wire identity predicate. */
export function isCollabWorkingCopySlug(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
