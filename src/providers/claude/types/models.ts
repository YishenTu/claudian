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
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
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

const DEFAULT_MODEL_VALUES = new Set(DEFAULT_CLAUDE_MODELS.map(m => m.value));

/** Whether the model is a known Claude model that supports adaptive thinking. */
export function isAdaptiveThinkingModel(model: string): boolean {
  if (DEFAULT_MODEL_VALUES.has(model)) return true;
  return /claude-(haiku|sonnet|opus)-/.test(model);
}

export const CONTEXT_WINDOW_STANDARD = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;

export function filterVisibleModelOptions<T extends { value: string }>(
  models: T[],
  enableOpus1M: boolean,
  enableSonnet1M: boolean
): T[] {
  return models.filter((model) => {
    if (model.value === 'opus' || model.value === 'opus[1m]') {
      return enableOpus1M ? model.value === 'opus[1m]' : model.value === 'opus';
    }

    if (model.value === 'sonnet' || model.value === 'sonnet[1m]') {
      return enableSonnet1M ? model.value === 'sonnet[1m]' : model.value === 'sonnet';
    }

    return true;
  });
}

export function normalizeVisibleModelVariant(
  model: string,
  enableOpus1M: boolean,
  enableSonnet1M: boolean
): string {
  if (model === 'opus' || model === 'opus[1m]') {
    return enableOpus1M ? 'opus[1m]' : 'opus';
  }

  if (model === 'sonnet' || model === 'sonnet[1m]') {
    return enableSonnet1M ? 'sonnet[1m]' : 'sonnet';
  }

  return model;
}

export function getContextWindowSize(
  model: string,
  customLimits?: Record<string, number>
): number {
  if (customLimits && model in customLimits) {
    const limit = customLimits[model];
    if (typeof limit === 'number' && limit > 0 && !isNaN(limit) && isFinite(limit)) {
      return limit;
    }
  }

  if (model.endsWith('[1m]')) {
    return CONTEXT_WINDOW_1M;
  }

  return CONTEXT_WINDOW_STANDARD;
}
