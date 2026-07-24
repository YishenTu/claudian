import type { ModelInfo } from '@qoder-ai/qoder-agent-sdk';

import {
  formatReasoningValueLabel,
  resolvePreferredReasoningDefault,
} from '../../core/providers/reasoning';

export interface QoderReasoningEffort {
  description?: string;
  label: string;
  value: string;
}

export interface QoderDiscoveredModel {
  contextWindow: number;
  contextWindowIsAuthoritative: boolean;
  defaultEffort?: string;
  description?: string;
  displayName: string;
  icon?: string;
  isDefault: boolean;
  rawId: string;
  reasoningEfforts: QoderReasoningEffort[];
  supportsReasoning: boolean;
}

export const QODER_MODEL_PREFIX = 'qoder/';
export const QODER_CONTEXT_WINDOW_FALLBACK = 200_000;
export const QODER_REASONING_EFFORT_FALLBACKS: readonly QoderReasoningEffort[] = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Max', value: 'max' },
];

export function encodeQoderModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  if (!normalized) return '';
  return normalized.startsWith(QODER_MODEL_PREFIX)
    ? normalized
    : `${QODER_MODEL_PREFIX}${normalized}`;
}

export function decodeQoderModelId(model: string): string | null {
  const normalized = model.trim();
  if (!normalized.startsWith(QODER_MODEL_PREFIX)) {
    return null;
  }
  const rawModelId = normalized.slice(QODER_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function isQoderModelSelectionId(model: string): boolean {
  return decodeQoderModelId(model) !== null;
}

export function normalizeQoderDiscoveredModels(value: unknown): QoderDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byId = new Map<string, QoderDiscoveredModel>();
  for (const entry of value) {
    const model = normalizeQoderDiscoveredModel(entry);
    if (!model) {
      continue;
    }
    byId.set(model.rawId, model);
  }
  return Array.from(byId.values());
}

export function normalizeQoderModelInfoList(value: readonly ModelInfo[]): QoderDiscoveredModel[] {
  return normalizeQoderDiscoveredModels(value);
}

export function findQoderModel(
  models: readonly QoderDiscoveredModel[],
  modelId: string,
): QoderDiscoveredModel | null {
  const rawId = decodeQoderModelId(modelId) ?? modelId.trim();
  if (!rawId) {
    return null;
  }
  return models.find(model => model.rawId === rawId) ?? null;
}

export function getQoderAvailableReasoningEfforts(
  model: QoderDiscoveredModel | null | undefined,
): readonly QoderReasoningEffort[] {
  if (!model) {
    return [];
  }
  if (model.reasoningEfforts.length > 0) {
    return model.reasoningEfforts;
  }
  return model.rawId === 'auto' || model.supportsReasoning || Boolean(model.defaultEffort)
    ? QODER_REASONING_EFFORT_FALLBACKS
    : [];
}

export function resolveQoderDefaultReasoningEffort(
  model: QoderDiscoveredModel | null | undefined,
  preferredEffort?: string,
): string {
  const availableValues = getQoderAvailableReasoningEfforts(model).map(effort => effort.value);
  const normalizedPreferred = preferredEffort?.trim();
  if (normalizedPreferred && availableValues.includes(normalizedPreferred)) {
    return normalizedPreferred;
  }

  const declaredDefault = model?.defaultEffort?.trim();
  if (declaredDefault && availableValues.includes(declaredDefault)) {
    return declaredDefault;
  }

  return resolvePreferredReasoningDefault(availableValues, 'high');
}

export function resolveQoderContextWindow(
  modelId: string,
  models: readonly QoderDiscoveredModel[],
  customContextLimits: Record<string, number> = {},
): number {
  const model = findQoderModel(models, modelId);
  if (model?.contextWindow && model.contextWindow > 0) {
    return model.contextWindow;
  }

  const rawModelId = decodeQoderModelId(modelId);
  const customLimit = customContextLimits[modelId]
    ?? (rawModelId ? customContextLimits[rawModelId] : undefined);
  return typeof customLimit === 'number' && Number.isFinite(customLimit) && customLimit > 0
    ? Math.floor(customLimit)
    : QODER_CONTEXT_WINDOW_FALLBACK;
}

function normalizeQoderDiscoveredModel(value: unknown): QoderDiscoveredModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const rawId = readTrimmedString(record.rawId ?? record.value ?? record.modelId ?? record.id);
  if (!rawId) {
    return null;
  }

  const displayName = readTrimmedString(
    record.displayName ?? record.display_name ?? record.label ?? record.name,
  ) || rawId;
  const description = readTrimmedString(record.description);
  const icon = readTrimmedString(record.icon);
  const nativeContextWindow = readPositiveNumber(
    record.defaultContextWindow ?? record.maxInputTokens,
  );
  const persistedContextWindow = readPositiveNumber(record.contextWindow);
  const contextWindow = nativeContextWindow
    ?? persistedContextWindow
    ?? QODER_CONTEXT_WINDOW_FALLBACK;
  const contextWindowIsAuthoritative = typeof record.contextWindowIsAuthoritative === 'boolean'
    ? record.contextWindowIsAuthoritative
    : nativeContextWindow !== undefined;
  const effortDescriptions = readEffortDescriptions(record.thinking_config);
  const reasoningEfforts = normalizeReasoningEfforts(record, effortDescriptions);
  const defaultEffort = readTrimmedString(record.defaultEffort);

  return {
    contextWindow,
    contextWindowIsAuthoritative,
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(description ? { description } : {}),
    displayName,
    ...(icon ? { icon } : {}),
    isDefault: record.isDefault === true,
    rawId,
    reasoningEfforts,
    supportsReasoning: record.isReasoning === true
      || record.supportsReasoning === true
      || reasoningEfforts.length > 0,
  };
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeReasoningEfforts(
  record: Record<string, unknown>,
  effortDescriptions: Record<string, string>,
): QoderReasoningEffort[] {
  if (Array.isArray(record.efforts)) {
    return record.efforts.flatMap((entry) => {
      const value = readTrimmedString(entry);
      if (!value) {
        return [];
      }
      const description = effortDescriptions[value];
      return [{
        ...(description ? { description } : {}),
        label: formatReasoningValueLabel(value),
        value,
      }];
    });
  }

  if (!Array.isArray(record.reasoningEfforts)) {
    return [];
  }
  return record.reasoningEfforts.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const normalized = entry as Record<string, unknown>;
    const value = readTrimmedString(normalized.value);
    if (!value) {
      return [];
    }
    const description = readTrimmedString(normalized.description);
    return [{
      ...(description ? { description } : {}),
      label: formatReasoningValueLabel(value),
      value,
    }];
  });
}

/**
 * Extracts per-effort descriptions from the server `thinking_config` block so
 * the reasoning selector can surface each level's meaning as a tooltip.
 */
function readEffortDescriptions(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const enabled = (value as Record<string, unknown>).enabled;
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) {
    return {};
  }
  const efforts = (enabled as Record<string, unknown>).efforts;
  if (!efforts || typeof efforts !== 'object' || Array.isArray(efforts)) {
    return {};
  }
  const descriptions: Record<string, string> = {};
  for (const [effort, entry] of Object.entries(efforts as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const description = readTrimmedString((entry as Record<string, unknown>).description);
      if (description) {
        descriptions[effort] = description;
      }
    }
  }
  return descriptions;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
