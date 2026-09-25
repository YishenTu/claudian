import {
  type ACPMetadata,
  type ACPModelInfo,
  type ACPSessionConfigOption,
  type ACPSessionModelState,
  extractACPSessionModelState,
} from '../../acp';
import {
  type GrokDiscoveredModel,
  normalizeGrokDiscoveredModels,
  normalizeGrokReasoningMetadata,
} from '../models';

export interface NormalizedGrokSessionModels {
  currentModelId: string | null;
  models: GrokDiscoveredModel[];
}

export function normalizeGrokSessionModelMetadata(response: {
  _meta?: ACPMetadata | null;
  configOptions?: ACPSessionConfigOption[] | null;
  models?: ACPSessionModelState | null;
}): NormalizedGrokSessionModels {
  const state = extractACPSessionModelState(response);
  const rawModelsById = new Map(
    (response.models?.availableModels ?? []).flatMap(model => {
      const id = resolveACPModelId(model);
      return id ? [[id, model] as const] : [];
    }),
  );
  const models = state.availableModels.flatMap(model => {
    const rawModel = rawModelsById.get(model.id);
    const metadata = {
      ...(model.id === state.currentModelId && isRecord(response._meta)
        ? response._meta
        : {}),
      ...(isRecord(rawModel?._meta) ? rawModel._meta : {}),
      ...(isRecord(model._meta) ? model._meta : {}),
    };
    return normalizeGrokDiscoveredModels([{
      ...metadata,
      description: model.description ?? rawModel?.description ?? undefined,
      displayName: model.name,
      rawId: model.id,
      ...(hasReasoningOptions(metadata) ? { reasoningMetadataResolved: true } : {}),
    }]);
  });

  return {
    currentModelId: state.currentModelId,
    models,
  };
}

export function normalizeGrokSetModelMetadata(
  rawModelId: string,
  metadata: ACPMetadata | null | undefined,
): GrokDiscoveredModel | null {
  if (!isRecord(metadata?.model)) return null;
  return normalizeGrokDiscoveredModels([{
    ...metadata.model,
    rawId: readModelId(metadata.model) ?? rawModelId,
    ...(hasReasoningOptions(metadata.model) ? { reasoningMetadataResolved: true } : {}),
  }])[0] ?? null;
}

export function normalizeGrokModelUpdateMetadata(
  value: unknown,
): NormalizedGrokSessionModels | null {
  const state = parseGrokModelUpdateState(value);
  return state ? normalizeGrokSessionModelMetadata({ models: state }) : null;
}

export function parseGrokModelUpdateState(
  value: unknown,
): ACPSessionModelState | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.models) ? value.models : value;
  if (
    !Array.isArray(candidate.availableModels)
    || typeof candidate.currentModelId !== 'string'
    || !candidate.currentModelId.trim()
    || !candidate.availableModels.every(isACPModelInfo)
  ) {
    return null;
  }

  return candidate as unknown as ACPSessionModelState;
}

function isACPModelInfo(value: unknown): value is ACPModelInfo {
  return isRecord(value)
    && typeof value.name === 'string'
    && readModelId(value) !== null;
}

function resolveACPModelId(model: ACPModelInfo): string | null {
  return readModelId(model);
}

function readModelId(value: Record<string, unknown>): string | null {
  const id = typeof value.modelId === 'string'
    ? value.modelId
    : typeof value.id === 'string'
      ? value.id
      : '';
  return id.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Omitted reasoning fields are a partial update, not an empty capability list. */
function hasReasoningOptions(metadata: Record<string, unknown>): boolean {
  return Array.isArray(metadata.reasoningEfforts ?? metadata.reasoning_efforts)
    || metadata.supportsReasoningEffort === false
    || metadata.supports_reasoning_effort === false
    || metadata.supportsReasoning === false
    || metadata.supports_reasoning === false
    || normalizeGrokReasoningMetadata(metadata).reasoningEfforts.length > 0;
}
