/**
 * Provider-neutral in-memory state for the usage guard feature.
 *
 * Providers that can measure their own rate-limit usage (currently only
 * Claude, via its OAuth usage endpoint) report a block here when usage
 * crosses the configured threshold. The chat feature layer reads this state
 * to stop sending new turns without importing provider internals.
 *
 * State is intentionally not persisted: it always starts unblocked on
 * plugin load and is re-derived from the next poll.
 */

export interface UsageGuardBlockState {
  /** Human-readable reason shown to the user when a send is blocked. */
  reason: string;
}

let currentBlock: UsageGuardBlockState | null = null;

export function setUsageGuardBlock(state: UsageGuardBlockState | null): void {
  currentBlock = state;
}

export function getUsageGuardBlock(): UsageGuardBlockState | null {
  return currentBlock;
}
