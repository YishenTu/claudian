import { toProviderRuntimeModelId } from '../../../core/providers/modelSelection';
import type { ProviderId } from '../../../core/providers/types';
import type { UsageInfo } from '../../../core/types';

export interface ContextUsageDisplayContext {
  providerId: ProviderId | null;
  model: string | null | undefined;
  customContextLimits?: Record<string, number>;
}

export function isValidContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function calculateUsagePercentage(contextTokens: number, contextWindow: number): number {
  return contextWindow > 0
    ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)))
    : 0;
}

function withContextWindow(usage: UsageInfo, contextWindow: number): UsageInfo {
  return {
    ...usage,
    contextWindow,
    percentage: calculateUsagePercentage(usage.contextTokens, contextWindow),
  };
}

function toRuntimeModelId(providerId: ProviderId | null, model: string): string {
  const trimmed = model.trim();
  return providerId ? toProviderRuntimeModelId(providerId, trimmed) : trimmed;
}

/** Saved usage from before model identity was recorded cannot prove a mismatch. */
function isSameModel(
  providerId: ProviderId | null,
  usageModel: string | undefined,
  model: string | null | undefined,
): boolean {
  if (!usageModel || !model) return true;
  return usageModel === model
    || toRuntimeModelId(providerId, usageModel) === toRuntimeModelId(providerId, model);
}

function resolveCustomContextLimit(
  context: ContextUsageDisplayContext,
): number | null {
  const { providerId, model, customContextLimits: customLimits } = context;
  if (!model || !customLimits) return null;

  const exact = customLimits[model];
  if (isValidContextWindow(exact)) return exact;

  const runtimeModel = toRuntimeModelId(providerId, model);
  const runtimeExact = customLimits[runtimeModel];
  if (isValidContextWindow(runtimeExact)) return runtimeExact;

  const normalize = (id: string): string => toRuntimeModelId(providerId, id).toLowerCase();
  const normalizedModel = normalize(runtimeModel);
  const matches = Object.entries(customLimits)
    .filter(([key, limit]) =>
      normalize(key) === normalizedModel
      && isValidContextWindow(limit)
    )
    .map(([, limit]) => limit);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Projects raw provider usage into the context meter's display value. A valid
 * provider-reported window for the current model wins; the user's custom limit
 * is only a fallback. Returns null when the meter should stay hidden.
 */
export function projectContextUsageDisplay(
  usage: UsageInfo | null,
  context: ContextUsageDisplayContext,
): UsageInfo | null {
  if (!usage || usage.contextTokens <= 0) return null;

  const reportedWindow = isValidContextWindow(usage.contextWindow)
    && isSameModel(context.providerId, usage.model, context.model)
    ? usage.contextWindow
    : null;
  const contextWindow = reportedWindow
    ?? resolveCustomContextLimit(context);
  return contextWindow === null ? null : withContextWindow(usage, contextWindow);
}

/**
 * Applies a raw usage update. A partial update without a valid window keeps the
 * last reported window of the same model; windows never cross models.
 */
export function mergeReportedUsage(previous: UsageInfo | null, next: UsageInfo): UsageInfo {
  if (isValidContextWindow(next.contextWindow)) return next;

  const retainedWindow = previous
    && previous.model === next.model
    && isValidContextWindow(previous.contextWindow)
    ? previous.contextWindow
    : 0;
  return withContextWindow(next, retainedWindow);
}

/** A model change drops the previous model's reported window from raw usage. */
export function clearReportedContextWindowForModel(
  usage: UsageInfo,
  model: string,
  providerId: ProviderId | null = null,
): UsageInfo {
  if (usage.model && isSameModel(providerId, usage.model, model)) return usage;
  return { ...usage, model, contextWindow: 0, percentage: 0 };
}
