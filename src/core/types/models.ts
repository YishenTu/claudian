/**
 * Model type definitions and constants.
 */

/** Model identifier (string to support custom models via environment variables). */
export type GeminiModel = string;

export const DEFAULT_GEMINI_MODELS: { value: GeminiModel; label: string; description: string }[] = [
  { value: 'auto', label: 'Auto', description: 'Auto-selects best model' },
  { value: 'pro', label: 'Pro', description: 'Complex reasoning (Pro tier)' },
  { value: 'flash', label: 'Flash', description: 'Fast and balanced (Flash tier)' },
  { value: 'flash-lite', label: 'Flash Lite', description: 'Fastest for simple tasks' },
];

export type ThinkingBudget = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

export const THINKING_BUDGETS: { value: ThinkingBudget; label: string; tokens: number }[] = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
  { value: 'xhigh', label: 'Ultra', tokens: 32000 },
];

/** Default thinking budget per model tier. */
export const DEFAULT_THINKING_BUDGET: Record<string, ThinkingBudget> = {
  'flash-lite': 'off',
  'flash': 'low',
  'pro': 'medium',
  'auto': 'medium',
};

export const CONTEXT_WINDOW_STANDARD = 1_000_000;
export const CONTEXT_WINDOW_FLASH = 1_000_000;

export function getContextWindowSize(
  _model: string,
  customLimits?: Record<string, number>
): number {
  if (customLimits && _model in customLimits) {
    const limit = customLimits[_model];
    if (typeof limit === 'number' && limit > 0 && !isNaN(limit) && isFinite(limit)) {
      return limit;
    }
  }

  return CONTEXT_WINDOW_STANDARD;
}
