import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ClaudeDiscoveredModel } from '../modelCatalog';
import { isEffortLevel } from '../types/models';
import { probeClaudeRuntime } from './probeClaudeRuntime';

/** Maps one Claude Code model report onto the persisted catalog row. */
export function toClaudeDiscoveredModel(model: ModelInfo): ClaudeDiscoveredModel {
  return {
    value: model.value,
    label: model.displayName || model.value,
    description: model.description,
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    // Older CLIs may report levels this build does not know; they cannot be requested.
    supportedEffortLevels: [...new Set((model.supportedEffortLevels ?? []).filter(isEffortLevel))],
    reasoningMetadataResolved: true,
  };
}

/** Claude Code's reported model choices, read from an independent SDK initialization. */
export async function probeClaudeModels(
  host: ProviderHost,
  signal?: AbortSignal,
): Promise<ClaudeDiscoveredModel[]> {
  const { models } = await probeClaudeRuntime(host, signal);
  return models.map(toClaudeDiscoveredModel);
}
