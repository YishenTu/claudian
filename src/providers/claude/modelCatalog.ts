/** Provider-owned snapshot of the choices returned by Claude Code. */
export interface ClaudeDiscoveredModel {
  value: string;
  label: string;
  description: string;
  resolvedModel?: string;
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
    models.set(id, {
      value: id,
      label: typeof item.label === 'string' && item.label.trim() ? item.label : id,
      description: typeof item.description === 'string' ? item.description : '',
      ...(typeof item.resolvedModel === 'string' && item.resolvedModel.trim()
        ? { resolvedModel: item.resolvedModel } : {}),
    });
  }
  return [...models.values()];
}
