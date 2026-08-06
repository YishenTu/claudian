export interface CursorDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

const CURSOR_MODEL_PREFIX = 'cursor:';

export function encodeCursorModelId(rawId: string): string {
  const normalized = rawId.trim();
  return normalized ? `${CURSOR_MODEL_PREFIX}${normalized}` : '';
}

export function decodeCursorModelId(value: string): string | null {
  if (!value.startsWith(CURSOR_MODEL_PREFIX)) return null;
  const rawId = value.slice(CURSOR_MODEL_PREFIX.length).trim();
  return rawId || null;
}

export function normalizeCursorDiscoveredModels(value: unknown): CursorDiscoveredModel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const models: CursorDiscoveredModel[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const rawId = firstText(record.modelId, record.id, record.rawId)?.trim() ?? '';
    if (!rawId || seen.has(rawId)) continue;
    seen.add(rawId);
    const label = firstText(record.name, record.label)?.trim() || rawId;
    const description = firstText(record.description)?.trim();
    models.push({ ...(description ? { description } : {}), label, rawId });
  }
  return models;
}

export function normalizeCursorVisibleModels(
  value: unknown,
  discoveredModels: CursorDiscoveredModel[] = [],
): string[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(discoveredModels.map(model => model.rawId));
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const rawId = entry.trim();
    if (!rawId || (known.size > 0 && !known.has(rawId)) || result.includes(rawId)) continue;
    result.push(rawId);
  }
  return result;
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}
