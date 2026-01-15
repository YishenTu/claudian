/**
 * Model type definitions and constants.
 */

import type { SdkBeta } from '@anthropic-ai/claude-agent-sdk';

/** Model identifier (string to support custom models via environment variables). */
export type ClaudeModel = string;

/** Default Claude model options. */
export const DEFAULT_CLAUDE_MODELS: { value: ClaudeModel; label: string; description: string }[] = [
  { value: 'haiku', label: 'Haiku', description: 'Fast and efficient' },
  { value: 'sonnet', label: 'Sonnet', description: 'Balanced performance' },
  { value: 'opus', label: 'Opus', description: 'Most capable' },
];

/** 1M context beta flag. */
export const BETA_1M_CONTEXT: SdkBeta = 'context-1m-2025-08-07';

/**
 * Resolves a model to its base model and optional beta flags.
 *
 * @param model - The model identifier
 * @param include1MBeta - If true, include 1M beta flag for 1M context window
 */
export function resolveModelWithBetas(model: string, include1MBeta = false): { model: string; betas?: SdkBeta[] } {
  if (include1MBeta) {
    return {
      model,
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
  'opus': 'medium',
};
