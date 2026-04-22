/**
 * Model type definitions and constants.
 */

/** Model identifier (string to support custom models via environment variables). */
export type ClaudeModel = string;

export const DEFAULT_CLAUDE_MODELS: { value: ClaudeModel; label: string; description: string }[] = [
  { value: 'haiku', label: 'Haiku', description: 'Fast and efficient' },
  { value: 'sonnet', label: 'Sonnet', description: 'Balanced performance' },
  { value: 'sonnet[1m]', label: 'Sonnet 1M', description: 'Balanced performance (1M context window)' },
  { value: 'opus', label: 'Opus', description: 'Most capable' },
  { value: 'opus[1m]', label: 'Opus 1M', description: 'Most capable (1M context window)' },
];

export type ThinkingBudget = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

export const THINKING_BUDGETS: { value: ThinkingBudget; label: string; tokens: number }[] = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
  { value: 'xhigh', label: 'Ultra', tokens: 32000 },
];

/** Effort levels for adaptive thinking models. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];

/** Default effort level per model tier. */
export const DEFAULT_EFFORT_LEVEL: Record<string, EffortLevel> = {
  'haiku': 'high',
  'sonnet': 'high',
  'sonnet[1m]': 'high',
  'opus': 'high',
  'opus[1m]': 'high',
};

/** Default thinking budget per model tier. */
export const DEFAULT_THINKING_BUDGET: Record<string, ThinkingBudget> = {
  'haiku': 'off',
  'sonnet': 'low',
  'sonnet[1m]': 'low',
  'opus': 'medium',
  'opus[1m]': 'medium',
};

const ONE_M_SUFFIX = '[1m]';
const DEFAULT_MODEL_VALUES = new Set(DEFAULT_CLAUDE_MODELS.map(m => m.value.toLowerCase()));

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

function has1MContextSuffix(model: string): boolean {
  return normalizeModelId(model).endsWith(ONE_M_SUFFIX);
}

function isBuiltInFamilyVariant(model: string, family: 'sonnet' | 'opus'): boolean {
  const normalized = normalizeModelId(model);
  return normalized === family || normalized === `${family}${ONE_M_SUFFIX}`;
}

function isValidContextLimit(limit: unknown): limit is number {
  return typeof limit === 'number' && limit > 0 && !isNaN(limit) && isFinite(limit);
}

function resolveCustomContextLimit(
  model: string,
  customLimits?: Record<string, number>,
): number | null {
  if (!customLimits) {
    return null;
  }

  const exactLimit = customLimits[model];
  if (isValidContextLimit(exactLimit)) {
    return exactLimit;
  }

  const normalizedModel = normalizeModelId(model);
  const matchingLimits = Object.entries(customLimits)
    .filter(([key, limit]) => key !== model && normalizeModelId(key) === normalizedModel && isValidContextLimit(limit))
    .map(([, limit]) => limit);

  return matchingLimits.length === 1 ? matchingLimits[0] : null;
}

/** Whether the model is a known Claude model that supports adaptive thinking. */
export function isAdaptiveThinkingModel(model: string): boolean {
  const normalized = normalizeModelId(model);
  if (DEFAULT_MODEL_VALUES.has(normalized)) return true;
  return /claude-(haiku|sonnet|opus)-/.test(normalized);
}

export function isDefaultClaudeModel(model: string): boolean {
  return DEFAULT_MODEL_VALUES.has(normalizeModelId(model));
}

/**
 * Whether the model supports the `xhigh` effort level. Opus 4.7+ only — the SDK
 * silently falls back to `high` on other models.
 */
export function supportsXHighEffort(model: string): boolean {
  const normalized = normalizeModelId(model);
  if (isBuiltInFamilyVariant(normalized, 'opus')) return true;
  return /claude-opus-(4-[7-9]|[5-9])/.test(normalized);
}

/** Clamp stored effort values to what the selected model actually supports. */
export function normalizeEffortLevel(
  model: string,
  effortLevel: unknown,
): EffortLevel {
  const allowsXHigh = supportsXHighEffort(model);
  const isSupported = EFFORT_LEVELS.some((level) =>
    level.value === effortLevel && (allowsXHigh || level.value !== 'xhigh')
  );

  if (isSupported) {
    return effortLevel as EffortLevel;
  }

  return DEFAULT_EFFORT_LEVEL[normalizeModelId(model)] ?? 'high';
}

export function resolveThinkingTokens(
  model: string,
  thinkingBudget: unknown,
): number | null {
  if (isAdaptiveThinkingModel(model)) {
    return null;
  }

  const budgetConfig = THINKING_BUDGETS.find((budget) => budget.value === thinkingBudget);
  const thinkingTokens = budgetConfig?.tokens ?? null;
  return thinkingTokens && thinkingTokens > 0 ? thinkingTokens : null;
}

export function resolveAdaptiveEffortLevel(
  model: string,
  effortLevel: unknown,
): EffortLevel | null {
  if (!isAdaptiveThinkingModel(model)) {
    return null;
  }

  return normalizeEffortLevel(model, effortLevel);
}

export const CONTEXT_WINDOW_STANDARD = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;

export function filterVisibleModelOptions<T extends { value: string }>(
  models: T[],
  enableOpus1M: boolean,
  enableSonnet1M: boolean
): T[] {
  return models.filter((model) => {
    if (isBuiltInFamilyVariant(model.value, 'opus')) {
      return enableOpus1M ? has1MContextSuffix(model.value) : normalizeModelId(model.value) === 'opus';
    }

    if (isBuiltInFamilyVariant(model.value, 'sonnet')) {
      return enableSonnet1M ? has1MContextSuffix(model.value) : normalizeModelId(model.value) === 'sonnet';
    }

    return true;
  });
}

export function normalizeVisibleModelVariant(
  model: string,
  enableOpus1M: boolean,
  enableSonnet1M: boolean
): string {
  if (isBuiltInFamilyVariant(model, 'opus')) {
    return enableOpus1M ? 'opus[1m]' : 'opus';
  }

  if (isBuiltInFamilyVariant(model, 'sonnet')) {
    return enableSonnet1M ? 'sonnet[1m]' : 'sonnet';
  }

  return model;
}

export function getContextWindowSize(
  model: string,
  customLimits?: Record<string, number>
): number {
  const customLimit = resolveCustomContextLimit(model, customLimits);
  if (customLimit !== null) {
    return customLimit;
  }

  if (has1MContextSuffix(model)) {
    return CONTEXT_WINDOW_1M;
  }

  return CONTEXT_WINDOW_STANDARD;
}
