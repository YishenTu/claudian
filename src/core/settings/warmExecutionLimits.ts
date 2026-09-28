export const DEFAULT_MAX_WARM_AGENT_PROCESSES = 5;
export const MIN_WARM_AGENT_PROCESSES = 5;
export const MAX_WARM_AGENT_PROCESSES = 10;

export function normalizeWarmExecutionLimit(configured: unknown): number {
  const finite = typeof configured === 'number' && Number.isFinite(configured)
    ? Math.trunc(configured)
    : DEFAULT_MAX_WARM_AGENT_PROCESSES;
  return Math.max(
    MIN_WARM_AGENT_PROCESSES,
    Math.min(MAX_WARM_AGENT_PROCESSES, finite),
  );
}
