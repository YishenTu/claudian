/**
 * Model usage selection helper.
 */

import type { ModelUsageInfo } from '../types';

/**
 * Select the appropriate model usage entry from modelUsage.
 * Prefers the entry matching message.model, otherwise picks the model with highest contextTokens.
 */
export function selectModelUsage(
  usageByModel: Record<string, ModelUsageInfo>,
  messageModel?: string
): { modelName: string; usage: ModelUsageInfo } | null {
  const entries = Object.entries(usageByModel);
  if (entries.length === 0) return null;

  // Prefer the entry matching message.model
  if (messageModel && usageByModel[messageModel]) {
    return { modelName: messageModel, usage: usageByModel[messageModel] };
  }

  // Otherwise pick the model with highest contextTokens
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
