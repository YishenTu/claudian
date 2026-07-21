import {
  formatReasoningValueLabel,
  resolvePreferredReasoningDefault,
  STANDARD_REASONING_VALUES,
} from '../../core/providers/reasoning';

export interface GrokReasoningEffort {
  description?: string;
  label: string;
  value: string;
}

export interface GrokDiscoveredModel {
  agentType?: string;
  contextWindow?: number;
  defaultReasoningEffort?: string;
  description?: string;
  displayName: string;
  rawId: string;
  reasoningMetadataResolved?: boolean;
  reasoningEfforts: GrokReasoningEffort[];
  supportsReasoning: boolean;
}

export const GROK_MODEL_PREFIX = 'grok/';
export const GROK_CONTEXT_WINDOW_FALLBACK = 200_000;
const GROK_REASONING_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const GROK_FALLBACK_REASONING_EFFORTS: readonly GrokReasoningEffort[] = Object.freeze(
  STANDARD_REASONING_VALUES.map(value => Object.freeze({
    label: formatReasoningValueLabel(value),
    value,
  })),
);

export function isGrokModelSelectionId(model: string): boolean {
  return decodeGrokModelId(model.trim()) !== null;
}

export function encodeGrokModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  if (!normalized || normalized === GROK_MODEL_PREFIX) {
    return '';
  }
  return normalized.startsWith(GROK_MODEL_PREFIX)
    ? normalized
    : `${GROK_MODEL_PREFIX}${normalized}`;
}

export function decodeGrokModelId(model: string): string | null {
  const normalized = model.trim();
  if (!normalized.startsWith(GROK_MODEL_PREFIX)) {
    return null;
  }
  const rawModelId = normalized.slice(GROK_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeGrokDiscoveredModels(value: unknown): GrokDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedById = new Map<string, GrokDiscoveredModel>();
  for (const entry of value) {
    const model = normalizeGrokDiscoveredModel(entry);
    if (!model) {
      continue;
    }

    const current = normalizedById.get(model.rawId);
    normalizedById.set(
      model.rawId,
      current ? mergeGrokModelMetadata(current, model) : model,
    );
  }
  return Array.from(normalizedById.values());
}

export function mergeGrokDiscoveredModels(
  catalogModels: GrokDiscoveredModel[],
  liveModels: GrokDiscoveredModel[],
): GrokDiscoveredModel[] {
  const merged = normalizeGrokDiscoveredModels(catalogModels);
  const indexes = new Map(merged.map((model, index) => [model.rawId, index] as const));

  for (const incoming of normalizeGrokDiscoveredModels(liveModels)) {
    const index = indexes.get(incoming.rawId);
    if (index === undefined) {
      indexes.set(incoming.rawId, merged.length);
      merged.push(incoming);
      continue;
    }
    merged[index] = mergeGrokModelMetadata(merged[index], incoming);
  }

  return merged;
}

export function findGrokModel(
  models: GrokDiscoveredModel[],
  modelId: string,
): GrokDiscoveredModel | null {
  const rawModelId = decodeGrokModelId(modelId) ?? modelId.trim();
  if (!rawModelId) {
    return null;
  }
  return models.find(model => model.rawId === rawModelId) ?? null;
}

export function getGrokAvailableReasoningEfforts(
  model: GrokDiscoveredModel | null | undefined,
): readonly GrokReasoningEffort[] {
  if (!model) {
    return [];
  }
  if (model.reasoningMetadataResolved !== true) {
    return GROK_FALLBACK_REASONING_EFFORTS;
  }
  if (model.reasoningEfforts.length > 0) {
    return model.reasoningEfforts;
  }
  return model.supportsReasoning
    ? GROK_FALLBACK_REASONING_EFFORTS
    : [];
}

export function clearGrokReasoningMetadata(
  model: GrokDiscoveredModel,
): GrokDiscoveredModel {
  const cleared = { ...model };
  delete cleared.defaultReasoningEffort;
  delete cleared.reasoningMetadataResolved;
  cleared.reasoningEfforts = [];
  cleared.supportsReasoning = false;
  return cleared;
}

export function resolveGrokDefaultReasoningEffort(
  model: GrokDiscoveredModel | null | undefined,
  preferredEffort?: string,
): string {
  const availableValues = model?.reasoningEfforts.map(effort => effort.value) ?? [];
  const normalizedPreferred = preferredEffort?.trim();
  if (normalizedPreferred && availableValues.includes(normalizedPreferred)) {
    return normalizedPreferred;
  }

  const declaredDefault = model?.defaultReasoningEffort?.trim();
  if (declaredDefault && availableValues.includes(declaredDefault)) {
    return declaredDefault;
  }

  return resolvePreferredReasoningDefault(availableValues, 'high');
}

export function resolveGrokContextWindow(
  modelId: string,
  models: GrokDiscoveredModel[],
  customContextLimits: Record<string, number> = {},
): number {
  const model = findGrokModel(models, modelId);
  if (model?.contextWindow !== undefined) {
    return model.contextWindow;
  }

  const rawModelId = decodeGrokModelId(modelId);
  const customLimit = customContextLimits[modelId]
    ?? (rawModelId ? customContextLimits[rawModelId] : undefined);
  return isPositiveFiniteNumber(customLimit)
    ? customLimit
    : GROK_CONTEXT_WINDOW_FALLBACK;
}

export function normalizeGrokReasoningMetadata(value: unknown): Pick<
  GrokDiscoveredModel,
  'defaultReasoningEffort' | 'reasoningEfforts' | 'supportsReasoning'
> {
  if (!isRecord(value)) {
    return { reasoningEfforts: [], supportsReasoning: false };
  }
  const sessionConfig = isRecord(value['x.ai/sessionConfig'])
    ? value['x.ai/sessionConfig']
    : null;
  const sessionOptions = normalizeGrokSessionReasoningOptions(sessionConfig?.options);
  const explicitEfforts = normalizeGrokReasoningEfforts(
    value.reasoningEfforts ?? value.reasoning_efforts,
  );
  const reasoningEfforts = explicitEfforts.length > 0
    ? explicitEfforts
    : sessionOptions.efforts;
  const defaultReasoningEffort = readTrimmedString(
    value.reasoningEffort
      ?? value.reasoning_effort
      ?? value.defaultReasoningEffort
      ?? value.default_reasoning_effort,
  ) ?? sessionOptions.selected;
  const supportsReasoning = value.supportsReasoning === true
    || value.supports_reasoning === true
    || value.supportsReasoningEffort === true
    || value.supports_reasoning_effort === true
    || reasoningEfforts.length > 0
    || Boolean(defaultReasoningEffort);
  return {
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    reasoningEfforts,
    supportsReasoning,
  };
}

function normalizeGrokDiscoveredModel(value: unknown): GrokDiscoveredModel | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawId = readTrimmedString(value.rawId ?? value.modelId ?? value.id);
  if (!rawId) {
    return null;
  }

  const reasoning = normalizeGrokReasoningMetadata(value);
  const agentType = readTrimmedString(value.agentType ?? value.agent_type);
  const contextWindow = readPositiveFiniteNumber(
    value.contextWindow
      ?? value.context_window
      ?? value.totalContextTokens
      ?? value.total_context_tokens,
  );
  const description = readTrimmedString(value.description);
  const displayName = readTrimmedString(
    value.displayName ?? value.display_name ?? value.name ?? value.label,
  ) || rawId;
  return {
    ...(agentType ? { agentType } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(reasoning.defaultReasoningEffort
      ? { defaultReasoningEffort: reasoning.defaultReasoningEffort }
      : {}),
    ...(description ? { description } : {}),
    displayName,
    rawId,
    ...(value.reasoningMetadataResolved === true
      ? { reasoningMetadataResolved: true }
      : {}),
    reasoningEfforts: reasoning.reasoningEfforts,
    supportsReasoning: reasoning.supportsReasoning,
  };
}

function normalizeGrokSessionReasoningOptions(value: unknown): {
  efforts: GrokReasoningEffort[];
  selected?: string;
} {
  if (!Array.isArray(value)) return { efforts: [] };
  const rows = value.filter((entry): entry is Record<string, unknown> => (
    isRecord(entry) && entry.category === 'mode'
  ));
  const efforts = normalizeGrokReasoningEfforts(rows).sort((left, right) => {
    const leftIndex = GROK_REASONING_EFFORT_ORDER.indexOf(
      left.value as (typeof GROK_REASONING_EFFORT_ORDER)[number],
    );
    const rightIndex = GROK_REASONING_EFFORT_ORDER.indexOf(
      right.value as (typeof GROK_REASONING_EFFORT_ORDER)[number],
    );
    if (leftIndex === -1) return rightIndex === -1 ? 0 : 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
  const selected = rows.find(row => row.selected === true);
  return {
    efforts,
    ...(selected ? { selected: readTrimmedString(selected.id ?? selected.value) } : {}),
  };
}

function normalizeGrokReasoningEfforts(value: unknown): GrokReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const efforts: GrokReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = isRecord(entry) ? entry : null;
    const effortValue = readTrimmedString(record?.value ?? record?.id ?? entry);
    if (!effortValue || seen.has(effortValue)) {
      continue;
    }
    seen.add(effortValue);
    const label = readTrimmedString(record?.label ?? record?.name)
      || formatReasoningValueLabel(effortValue);
    const description = readTrimmedString(record?.description);
    efforts.push({
      ...(description ? { description } : {}),
      label,
      value: effortValue,
    });
  }
  return efforts;
}

function mergeGrokModelMetadata(
  current: GrokDiscoveredModel,
  incoming: GrokDiscoveredModel,
): GrokDiscoveredModel {
  const incomingReasoningIsAuthoritative = incoming.reasoningMetadataResolved === true;
  const reasoningEfforts = incomingReasoningIsAuthoritative
    ? incoming.reasoningEfforts
    : incoming.reasoningEfforts.length > 0
      ? incoming.reasoningEfforts
      : current.reasoningEfforts;
  const defaultReasoningEffort = incomingReasoningIsAuthoritative
    ? incoming.defaultReasoningEffort
    : incoming.defaultReasoningEffort ?? current.defaultReasoningEffort;
  const incomingDisplayNameIsRich = incoming.displayName !== incoming.rawId;

  return {
    ...(incoming.agentType ?? current.agentType
      ? { agentType: incoming.agentType ?? current.agentType }
      : {}),
    ...(incoming.contextWindow ?? current.contextWindow
      ? { contextWindow: incoming.contextWindow ?? current.contextWindow }
      : {}),
    ...(defaultReasoningEffort
      ? { defaultReasoningEffort }
      : {}),
    ...(incoming.description ?? current.description
      ? { description: incoming.description ?? current.description }
      : {}),
    displayName: incomingDisplayNameIsRich ? incoming.displayName : current.displayName,
    rawId: current.rawId,
    ...(incoming.reasoningMetadataResolved || current.reasoningMetadataResolved
      ? { reasoningMetadataResolved: true }
      : {}),
    reasoningEfforts,
    supportsReasoning: incomingReasoningIsAuthoritative
      ? incoming.supportsReasoning || reasoningEfforts.length > 0
      : incoming.supportsReasoning
        || current.supportsReasoning
        || reasoningEfforts.length > 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPositiveFiniteNumber(value: unknown): number | undefined {
  return isPositiveFiniteNumber(value) ? Math.floor(value) : undefined;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
