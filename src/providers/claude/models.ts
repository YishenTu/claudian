import { type EffortLevel, isEffortLevel } from './types/models';

/** Provider-owned snapshot of the choices returned by Claude Code. */
export interface ClaudeDiscoveredModel {
  value: string;
  label: string;
  description: string;
  resolvedModel?: string;
  /** Effort levels Claude Code reported for this model; absent when not reported. */
  supportedEffortLevels?: EffortLevel[];
  reasoningMetadataResolved?: boolean;
}

function decodeSupportedEffortLevels(value: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set((value as unknown[]).filter(isEffortLevel))];
}

export function decodeClaudeModels(value: unknown): ClaudeDiscoveredModel[] {
  if (!Array.isArray(value)) return [];
  const models = new Map<string, ClaudeDiscoveredModel>();
  for (const candidate of value as unknown[]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Record<string, unknown>;
    if (typeof item.value !== 'string') continue;
    const id = item.value.trim();
    if (!id || models.has(id)) continue;
    const supportedEffortLevels = decodeSupportedEffortLevels(item.supportedEffortLevels);
    models.set(id, {
      value: id,
      label: typeof item.label === 'string' && item.label.trim() ? item.label : id,
      description: typeof item.description === 'string' ? item.description : '',
      ...(typeof item.resolvedModel === 'string' && item.resolvedModel.trim()
        ? { resolvedModel: item.resolvedModel } : {}),
      ...(item.reasoningMetadataResolved === true ? { reasoningMetadataResolved: true } : {}),
      ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
    });
  }
  return [...models.values()];
}
