export interface DeepSeekModel {
  readonly encodedId: string;
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  readonly reasoning?: readonly { readonly id: string; readonly name: string }[];
  readonly description?: string;
  readonly available?: boolean;
}

const PREFIX = 'deepseek:';

export function encodeDeepSeekModelId(provider: string, model: string): string {
  if (!provider.trim() || !model.trim()) throw new Error('DeepSeek model requires a provider and model ID.');
  return `${PREFIX}${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
}

export function decodeDeepSeekModelId(value: string): { provider: string; model: string } | null {
  if (!value.startsWith(PREFIX)) return null;
  const parts = value.slice(PREFIX.length).split('/');
  if (parts.length !== 2) return null;
  try {
    const [provider, model] = parts.map(decodeURIComponent);
    return provider.trim() && model.trim() ? { provider, model } : null;
  } catch {
    return null;
  }
}

export function normalizeDeepSeekModels(value: unknown): DeepSeekModel[] {
  if (!Array.isArray(value)) return [];
  const models = new Map<string, DeepSeekModel>();
  for (const candidate of value as unknown[]) {
    const entry = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
    if (typeof entry.provider !== 'string' || !entry.provider.trim()
      || typeof entry.id !== 'string' || !entry.id.trim()) continue;
    const encodedId = encodeDeepSeekModelId(entry.provider, entry.id);
    if (models.has(encodedId)) continue;
    const reasoning: Array<{ id: string; name: string }> = [];
    if (Array.isArray(entry.reasoning)) {
      for (const value of entry.reasoning as unknown[]) {
        const effort = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        if (typeof effort.id === 'string' && effort.id.trim()
          && typeof effort.name === 'string' && !reasoning.some(row => row.id === effort.id)) {
          reasoning.push({ id: effort.id, name: effort.name });
        }
      }
    }
    models.set(encodedId, {
      encodedId, provider: entry.provider, id: entry.id,
      label: typeof entry.label === 'string' ? entry.label : entry.id,
      ...(Array.isArray(entry.reasoning) ? { reasoning } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(typeof entry.available === 'boolean' ? { available: entry.available } : {}),
    });
  }
  return [...models.values()];
}
