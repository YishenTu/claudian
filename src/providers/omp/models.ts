export interface OmpDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface OmpConfigChoice {
  description?: string;
  id: string;
  name: string;
}

export interface OmpThinkingConfig {
  configId: string;
  currentValue: string | null;
  options: OmpConfigChoice[];
}

export function normalizeOmpConfigChoiceList(value: unknown): OmpConfigChoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: OmpConfigChoice[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id;
    const description = typeof record.description === 'string' && record.description.trim()
      ? record.description.trim()
      : undefined;
    result.push({ ...(description ? { description } : {}), id, name });
  }
  return result;
}

export function normalizeOmpThinkingConfig(value: unknown): OmpThinkingConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const configId = typeof record.configId === 'string' ? record.configId.trim() : '';
  if (!configId) return null;
  return {
    configId,
    currentValue: typeof record.currentValue === 'string' && record.currentValue.trim()
      ? record.currentValue
      : null,
    options: normalizeOmpConfigChoiceList(record.options),
  };
}

const OMP_MODEL_PREFIX = 'omp:';

export function encodeOmpModelId(rawId: string): string {
  const normalized = rawId.trim();
  return normalized ? `${OMP_MODEL_PREFIX}${normalized}` : '';
}

export function decodeOmpModelId(value: string): string | null {
  if (!value.startsWith(OMP_MODEL_PREFIX)) return null;
  const rawId = value.slice(OMP_MODEL_PREFIX.length).trim();
  return rawId || null;
}

export function normalizeOmpDiscoveredModels(value: unknown): OmpDiscoveredModel[] {
  if (!Array.isArray(value)) return [];
  const result: OmpDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const rawId = firstText(record.rawId, record.id, record.modelId)?.trim() ?? '';
    if (!rawId || seen.has(rawId)) continue;
    seen.add(rawId);
    const label = firstText(record.label, record.name)?.trim() || rawId;
    const description = firstText(record.description)?.trim();
    result.push({ ...(description ? { description } : {}), label, rawId });
  }
  return result;
}

export function normalizeOmpConfigOptionModels(value: unknown): OmpDiscoveredModel[] {
  if (!Array.isArray(value)) return [];
  const modelOption = value.find(option => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
    const record = option as Record<string, unknown>;
    return record.id === 'model' && record.type === 'select';
  }) as Record<string, unknown> | undefined;
  if (!modelOption || !Array.isArray(modelOption.options)) return [];

  return normalizeOmpDiscoveredModels(modelOption.options.map(option => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
    const record = option as Record<string, unknown>;
    return {
      description: record.description,
      name: record.name,
      modelId: record.value,
    };
  }));
}

export function normalizeOmpConfigChoices(
  value: unknown,
  category: 'mode' | 'thought_level',
): { configId: string | null; currentValue: string | null; options: OmpConfigChoice[] } {
  if (!Array.isArray(value)) return { configId: null, currentValue: null, options: [] };
  const configOption = value.find(option => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
    const record = option as Record<string, unknown>;
    return record.type === 'select'
      && (record.category === category || (category === 'thought_level' && record.id === 'thinking'));
  }) as Record<string, unknown> | undefined;
  if (!configOption || !Array.isArray(configOption.options)) {
    return { configId: null, currentValue: null, options: [] };
  }
  const seen = new Set<string>();
  const options: OmpConfigChoice[] = [];
  for (const option of configOption.options) {
    if (!option || typeof option !== 'object' || Array.isArray(option)) continue;
    const record = option as Record<string, unknown>;
    const id = typeof record.value === 'string' ? record.value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id;
    const description = typeof record.description === 'string' && record.description.trim()
      ? record.description.trim()
      : undefined;
    options.push({ ...(description ? { description } : {}), id, name });
  }
  return {
    configId: typeof configOption.id === 'string' && configOption.id.trim() ? configOption.id : null,
    currentValue: typeof configOption.currentValue === 'string' && configOption.currentValue.trim()
      ? configOption.currentValue
      : null,
    options,
  };
}

export function normalizeOmpVisibleModels(
  value: unknown,
  discoveredModels: OmpDiscoveredModel[] = [],
): string[] {
  if (!Array.isArray(value)) return [];
  const known = new Map(discoveredModels.map(model => [canonicalizeOmpModelId(model.rawId), model.rawId]));
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const rawId = entry.trim();
    if (!rawId) continue;
    const resolved = known.get(canonicalizeOmpModelId(rawId)) ?? rawId;
    if (result.includes(resolved)) continue;
    result.push(resolved);
  }
  return result;
}

function canonicalizeOmpModelId(value: string): string {
  return value.trim()
    .replace(/^omp:/iu, '')
    .replace(/:+/gu, '/')
    .replace(/\/{2,}/gu, '/')
    .toLowerCase();
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}
