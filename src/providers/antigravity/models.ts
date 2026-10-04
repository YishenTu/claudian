import type { AntigravityDiscoveredModel } from './types';

export const ANTIGRAVITY_MODEL_PREFIX = 'antigravity:';
export const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-3.8-flash-high';

export interface AntigravityBaseModel {
  description?: string;
  label: string;
  rawId: string;
}

export const DEFAULT_ANTIGRAVITY_MODELS: AntigravityBaseModel[] = [
  {
    rawId: 'gemini-3.8-flash-high',
    label: 'Gemini 3.8 Flash (High Thinking)',
    description: 'Latest high reasoning speed model for code and agentic tasks',
  },
  {
    rawId: 'gemini-3.8-flash-medium',
    label: 'Gemini 3.8 Flash (Medium Thinking)',
    description: 'Balanced reasoning speed and token budget',
  },
  {
    rawId: 'gemini-3.8-flash-low',
    label: 'Gemini 3.8 Flash (Low Thinking)',
    description: 'Fastest reasoning turn with minimal thinking overhead',
  },
  {
    rawId: 'gemini-3.7-flash-high',
    label: 'Gemini 3.7 Flash (High Thinking)',
    description: 'High reasoning effort with strong coding capabilities',
  },
  {
    rawId: 'gemini-3.7-flash-medium',
    label: 'Gemini 3.7 Flash (Medium Thinking)',
    description: 'Moderate reasoning effort',
  },
  {
    rawId: 'gemini-3.7-flash-low',
    label: 'Gemini 3.7 Flash (Low Thinking)',
    description: 'Low reasoning effort',
  },
  {
    rawId: 'gemini-3.6-flash-high',
    label: 'Gemini 3.6 Flash (High Thinking)',
    description: 'Gemini 3.6 Flash high thinking',
  },
  {
    rawId: 'gemini-3.6-flash-medium',
    label: 'Gemini 3.6 Flash (Medium Thinking)',
    description: 'Gemini 3.6 Flash medium thinking',
  },
  {
    rawId: 'gemini-3.6-flash-low',
    label: 'Gemini 3.6 Flash (Low Thinking)',
    description: 'Gemini 3.6 Flash low thinking',
  },
  {
    rawId: 'gemini-pro-agent',
    label: 'Gemini 3.1 Pro (High Thinking)',
    description: 'Advanced reasoning model for complex architectural tasks',
  },
  {
    rawId: 'gemini-3.1-pro-low',
    label: 'Gemini 3.1 Pro (Low Thinking)',
    description: 'Pro model with concise thinking',
  },
];

export function isAntigravityModelSelectionId(model: string): boolean {
  return decodeAntigravityModelId(model) !== null;
}

export function encodeAntigravityModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${ANTIGRAVITY_MODEL_PREFIX}${normalized}` : '';
}

export function decodeAntigravityModelId(model: string): string | null {
  if (!model.startsWith(ANTIGRAVITY_MODEL_PREFIX)) {
    return null;
  }

  const rawModelId = model.slice(ANTIGRAVITY_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeAntigravityDiscoveredModels(value: unknown): AntigravityDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: AntigravityDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;

    const rawId = typeof record.rawId === 'string'
      ? record.rawId.trim()
      : typeof record.modelId === 'string'
        ? record.modelId.trim()
        : typeof record.id === 'string'
          ? record.id.trim()
          : '';
    const label = typeof record.label === 'string'
      ? record.label.trim()
      : typeof record.name === 'string'
        ? record.name.trim()
        : rawId;
    const description = typeof record.description === 'string'
      ? record.description.trim()
      : '';

    if (!rawId || seen.has(rawId)) {
      continue;
    }

    seen.add(rawId);
    normalized.push({
      ...(description ? { description } : {}),
      label: label || rawId,
      rawId,
    });
  }

  return normalized;
}

export function getAntigravityEffectiveModels(
  discovered: AntigravityDiscoveredModel[] = [],
): AntigravityBaseModel[] {
  const discoveredMap = new Map<string, AntigravityBaseModel>();
  for (const model of DEFAULT_ANTIGRAVITY_MODELS) {
    discoveredMap.set(model.rawId, model);
  }
  for (const model of discovered) {
    discoveredMap.set(model.rawId, {
      rawId: model.rawId,
      label: model.label || model.rawId,
      ...(model.description ? { description: model.description } : {}),
    });
  }
  return Array.from(discoveredMap.values());
}
