/**
 * Model usage selection helper.
 */

import type { ModelUsageInfo } from '../types';

/**
 * Select the appropriate model usage entry from modelUsage.
 * Priority: 1) message.model from SDK, 2) intendedModel from settings, 3) highest contextTokens.
 * The intendedModel fallback ensures we don't accidentally pick subagent model usage
 * when the SDK doesn't provide message.model.
 */
export function selectModelUsage(
  usageByModel: Record<string, ModelUsageInfo>,
  messageModel?: string,
  intendedModel?: string
): { modelName: string; usage: ModelUsageInfo } | null {
  const entries = Object.entries(usageByModel);
  if (entries.length === 0) return null;

  // 1. Prefer the entry matching message.model (SDK-provided)
  if (messageModel && usageByModel[messageModel]) {
    return { modelName: messageModel, usage: usageByModel[messageModel] };
  }

  // 2. Fall back to intended model from settings (ignores subagent models)
  if (intendedModel && usageByModel[intendedModel]) {
    return { modelName: intendedModel, usage: usageByModel[intendedModel] };
  }

  // 3. Last resort: pick the model with highest contextTokens
  let bestEntry: { modelName: string; usage: ModelUsageInfo } | null = null;
  let maxTokens = -1;

  for (const [modelName, usage] of entries) {
    const contextTokens =
      (usage.inputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0);
    if (contextTokens > maxTokens) {
      maxTokens = contextTokens;
      bestEntry = { modelName, usage };
    }
  }

  return bestEntry;
}
