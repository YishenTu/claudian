/**
 * Model type definitions and constants.
 */

import type { SdkBeta } from '@anthropic-ai/claude-agent-sdk';

/** Model identifier (string to support custom models via environment variables). */
export type ClaudeModel = string;

export const DEFAULT_CLAUDE_MODELS: { value: ClaudeModel; label: string; description: string }[] = [
  { value: 'haiku', label: 'Haiku', description: 'Fast and efficient' },
  { value: 'sonnet', label: 'Sonnet', description: 'Balanced performance' },
  { value: 'opus', label: 'Opus', description: 'Most capable' },
];

export const BETA_1M_CONTEXT: SdkBeta = 'context-1m-2025-08-07';

export interface ModelWithBetas {
  model: string;
  betas: SdkBeta[];
}

export interface ModelWithoutBetas {
  model: string;
  betas?: undefined;
}

/** Resolves a model to its base model and optional beta flags. */
export function resolveModelWithBetas(model: string, include1MBeta: true): ModelWithBetas;
export function resolveModelWithBetas(model: string, include1MBeta?: false): ModelWithoutBetas;
export function resolveModelWithBetas(model: string, include1MBeta: boolean): ModelWithBetas | ModelWithoutBetas;
export function resolveModelWithBetas(model: string, include1MBeta = false): ModelWithBetas | ModelWithoutBetas {
  if (!model || typeof model !== 'string') {
    throw new Error('resolveModelWithBetas: model is required and must be a non-empty string');
  }
  if (include1MBeta) {
    return {
      model,
      betas: [BETA_1M_CONTEXT],
    };
  }
  return { model };
}

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
  'haiku': 'off',
  'sonnet': 'low',
  'opus': 'medium',
};

export const CONTEXT_WINDOW_STANDARD = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;

export function getContextWindowSize(
  model: string,
  is1MEnabled = false,
  customLimits?: Record<string, number>
): number {
  if (customLimits && model in customLimits) {
    const limit = customLimits[model];
    if (typeof limit === 'number' && limit > 0 && !isNaN(limit) && isFinite(limit)) {
      return limit;
    }
  }

  // 1M context only applies to sonnet
  if (is1MEnabled && model.includes('sonnet')) {
    return CONTEXT_WINDOW_1M;
  }
  return CONTEXT_WINDOW_STANDARD;
}
