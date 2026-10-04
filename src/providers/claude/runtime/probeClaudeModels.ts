import type { ModelInfo, SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ClaudeDiscoveredModel } from '../modelCatalog';
import { decodeOutputStyles } from '../settings';
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

/** What one Claude Code initialization reports for settings: model choices and output style names. */
export interface ClaudeRuntimeCatalog {
  readonly models: ClaudeDiscoveredModel[];
  readonly outputStyles: string[];
}

/** Maps Claude Code's initialization answer onto the persisted catalog. */
export function toClaudeRuntimeCatalog(
  initialization: Pick<SDKControlInitializeResponse, 'models' | 'available_output_styles'>,
): ClaudeRuntimeCatalog {
  return {
    models: initialization.models.map(toClaudeDiscoveredModel),
    outputStyles: decodeOutputStyles(initialization.available_output_styles),
  };
}

/** Claude Code's reported catalog, read from an independent SDK initialization. */
export async function probeClaudeCatalog(
  host: ProviderHost,
  signal?: AbortSignal,
): Promise<ClaudeRuntimeCatalog> {
  return toClaudeRuntimeCatalog(await probeClaudeRuntime(host, signal));
}
