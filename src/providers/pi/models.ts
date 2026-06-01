export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface PiDiscoveredModel {
  api?: string;
  contextWindow?: number;
  encodedId: string;
  id: string;
  input: Array<'text' | 'image'>;
  label: string;
  maxTokens?: number;
  provider: string;
  reasoning: boolean;
  thinkingLevels: PiThinkingLevel[];
}

export interface DecodedPiModelId {
  modelId: string;
  provider: string;
}

export const PI_SYNTHETIC_MODEL_ID = 'pi';
export const PI_MODEL_PREFIX = 'pi:';
export const PI_DEFAULT_THINKING_LEVEL: PiThinkingLevel = 'medium';

const VALID_THINKING_LEVELS = new Set<PiThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

const DEFAULT_REASONING_LEVELS: PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
];

export function isPiModelSelectionId(model: string): boolean {
  return model === PI_SYNTHETIC_MODEL_ID || model.startsWith(PI_MODEL_PREFIX);
}

export function encodePiModelId(provider: string, modelId: string): string {
  const normalizedProvider = provider.trim();
  const normalizedModelId = modelId.trim();
  if (!normalizedProvider || !normalizedModelId) {
    return PI_SYNTHETIC_MODEL_ID;
  }

  return `${PI_MODEL_PREFIX}${normalizedProvider}/${normalizedModelId}`;
}

export function decodePiModelId(model: string): DecodedPiModelId | null {
  if (!model.startsWith(PI_MODEL_PREFIX)) {
    return null;
  }

  const raw = model.slice(PI_MODEL_PREFIX.length).trim();
  const slashIndex = raw.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= raw.length - 1) {
    return null;
  }

  const provider = raw.slice(0, slashIndex).trim();
  const modelId = raw.slice(slashIndex + 1).trim();
  return provider && modelId ? { provider, modelId } : null;
}

export function normalizePiThinkingLevel(value: unknown): PiThinkingLevel | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return VALID_THINKING_LEVELS.has(normalized as PiThinkingLevel)
    ? normalized as PiThinkingLevel
    : null;
}

export function getPiSupportedThinkingLevels(value: unknown): PiThinkingLevel[] {
  const record = isPlainObject(value) ? value : {};
  const explicitLevels = collectExplicitThinkingLevels(record);
  const mappedLevels = collectThinkingLevelMapLevels(record);
  const reasoning = record.reasoning === true
    || record.supportsReasoning === true
    || record.thinking === true
    || record.canReason === true
    || explicitLevels.length > 0
    || mappedLevels.levels.length > 0;
  if (!reasoning) {
    return ['off'];
  }

  if (explicitLevels.length === 0 && mappedLevels.levels.length === 0) {
    return [...DEFAULT_REASONING_LEVELS];
  }

  const result: PiThinkingLevel[] = [];
  const seen = new Set<PiThinkingLevel>();
  for (const level of [...explicitLevels, ...mappedLevels.levels]) {
    if (level === null || mappedLevels.disabledLevels.has(level)) {
      continue;
    }

    if (!seen.has(level)) {
      seen.add(level);
      result.push(level);
    }
  }

  return result.length > 0 ? sortThinkingLevels(result) : [...DEFAULT_REASONING_LEVELS];
}

export function normalizePiDiscoveredModels(value: unknown): PiDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: PiDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      continue;
    }

    const provider = firstString(entry.provider, entry.providerId, entry.api)?.trim() ?? '';
    const id = firstString(entry.id, entry.modelId, entry.model, entry.name)?.trim() ?? '';
    if (!provider || !id) {
      continue;
    }

    const key = `${provider}\0${id}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const label = firstString(entry.label, entry.displayName, entry.name)?.trim()
      || `${provider}/${id}`;
    const api = firstString(entry.api)?.trim();
    const contextWindow = firstFinitePositiveNumber(
      entry.contextWindow,
      entry.context_window,
      entry.context,
      entry.maxContextTokens,
      entry.max_context_tokens,
    );
    const maxTokens = firstFinitePositiveNumber(
      entry.maxTokens,
      entry.max_tokens,
      entry.outputTokens,
      entry.output_tokens,
    );
    const input = normalizeModelInputs(
      entry.input ?? entry.inputs ?? entry.modalities ?? entry.supportedInputs,
    );
    const thinkingLevels = getPiSupportedThinkingLevels(entry);
    const reasoning = thinkingLevels.some(level => level !== 'off');

    normalized.push({
      ...(api ? { api } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      encodedId: encodePiModelId(provider, id),
      id,
      input,
      label,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      provider,
      reasoning,
      thinkingLevels,
    });
  }

  return normalized;
}

export function findPiModel(
  settings: { discoveredModels: PiDiscoveredModel[] },
  encodedId: string,
): PiDiscoveredModel | null {
  return settings.discoveredModels.find(model => model.encodedId === encodedId) ?? null;
}

export function clampPiThinkingLevel(
  level: string | undefined,
  supportedLevels: PiThinkingLevel[],
): PiThinkingLevel {
  const normalized = normalizePiThinkingLevel(level);
  if (normalized && supportedLevels.includes(normalized)) {
    return normalized;
  }

  if (supportedLevels.includes(PI_DEFAULT_THINKING_LEVEL)) {
    return PI_DEFAULT_THINKING_LEVEL;
  }

  return supportedLevels[0] ?? 'off';
}

function collectExplicitThinkingLevels(record: Record<string, unknown>): Array<PiThinkingLevel | null> {
  const rawLevels = [
    record.thinkingLevels,
    record.thinking_levels,
    record.reasoningLevels,
    record.reasoning_levels,
    isPlainObject(record.thinking) ? record.thinking.levels : undefined,
    isPlainObject(record.reasoning) ? record.reasoning.levels : undefined,
  ].find(Array.isArray);

  if (!Array.isArray(rawLevels)) {
    return [];
  }

  return rawLevels
    .map((level): PiThinkingLevel | null | undefined => {
      if (level === null) {
        return null;
      }
      return normalizePiThinkingLevel(level) ?? undefined;
    })
    .filter((level): level is PiThinkingLevel | null => level !== undefined);
}

function collectThinkingLevelMapLevels(record: Record<string, unknown>): {
  disabledLevels: Set<PiThinkingLevel>;
  levels: PiThinkingLevel[];
} {
  const rawMap = isPlainObject(record.thinkingLevelMap)
    ? record.thinkingLevelMap
    : isPlainObject(record.thinking_level_map)
    ? record.thinking_level_map
    : null;
  if (!rawMap) {
    return { disabledLevels: new Set<PiThinkingLevel>(), levels: [] };
  }

  const disabledLevels = new Set<PiThinkingLevel>();
  const levels: PiThinkingLevel[] = [...DEFAULT_REASONING_LEVELS];
  for (const [rawLevel, mappedLevel] of Object.entries(rawMap)) {
    const level = normalizePiThinkingLevel(rawLevel);
    if (!level) {
      continue;
    }
    if (mappedLevel === null) {
      disabledLevels.add(level);
    } else {
      levels.push(level);
    }
  }
  return { disabledLevels, levels };
}

function sortThinkingLevels(levels: PiThinkingLevel[]): PiThinkingLevel[] {
  const rank = new Map(DEFAULT_REASONING_LEVELS.concat('xhigh').map((level, index) => [level, index] as const));
  return [...levels].sort((left, right) => (rank.get(left) ?? 99) - (rank.get(right) ?? 99));
}

function normalizeModelInputs(value: unknown): Array<'text' | 'image'> {
  const rawInputs = Array.isArray(value) ? value : ['text'];
  const inputs: Array<'text' | 'image'> = [];
  const seen = new Set<'text' | 'image'>();

  for (const entry of rawInputs) {
    const normalized = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    const input = normalized === 'image' || normalized === 'images'
      ? 'image'
      : normalized === 'text'
      ? 'text'
      : null;
    if (input && !seen.has(input)) {
      seen.add(input);
      inputs.push(input);
    }
  }

  return inputs.length > 0 ? inputs : ['text'];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function firstFinitePositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
