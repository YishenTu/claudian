/**
 * Model type definitions and constants.
 */

import type { SdkBeta } from '@anthropic-ai/claude-agent-sdk';

/** Model identifier (string to support custom models via environment variables). */
export type ClaudeModel = string;

/** Default Claude model options. */
export const DEFAULT_CLAUDE_MODELS: { value: ClaudeModel; label: string; description: string; is1M?: boolean }[] = [
  { value: 'haiku', label: 'Haiku', description: 'Fast and efficient' },
  { value: 'sonnet', label: 'Sonnet', description: 'Balanced performance' },
  { value: 'sonnet-1m', label: 'Sonnet (1M)', description: '1M context window', is1M: true },
  { value: 'opus', label: 'Opus', description: 'Most capable' },
];

/** 1M context beta flag. */
export const BETA_1M_CONTEXT: SdkBeta = 'context-1m-2025-08-07';

/**
 * Checks if a model is a 1M context variant.
 */
export function is1MModel(model: string): boolean {
  return model.endsWith('-1m');
}

/**
 * Resolves a model to its base model and optional beta flags.
 * For 1M variants (e.g., 'sonnet-1m'), returns the base model with the 1M beta flag.
 */
export function resolveModelWithBetas(model: string): { model: string; betas?: SdkBeta[] } {
  if (is1MModel(model)) {
    return {
      model: model.replace('-1m', ''),
      betas: [BETA_1M_CONTEXT],
    };
  }
  return { model };
}

/** Extended thinking token budget levels. */
export type ThinkingBudget = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** Thinking budget configuration with token counts. */
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
  'sonnet-1m': 'low',  // Same as sonnet base model
  'opus': 'medium',
};
