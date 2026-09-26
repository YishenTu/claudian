/**
 * Model type definitions and constants.
 */

import {
  DEFAULT_REASONING_VALUE,
} from '../../../core/providers/reasoning';
import { toClaudeRuntimeModelId } from '../modelSelection';
import {
  CLAUDE_MODEL_TIER_DEFINITIONS,
  isClaudeModelTier,
} from '../modelTiers';

/** Model identifier (string to support custom models via environment variables). */
export type ClaudeModel = string;

export const DEFAULT_CLAUDE_MODELS: { value: ClaudeModel; label: string; description: string }[] =
  CLAUDE_MODEL_TIER_DEFINITIONS.map(({ id, label, description }) => ({
    value: id,
    label,
    description,
  }));

/** Effort levels for adaptive thinking models. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVEL_VALUES: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string'
    && (EFFORT_LEVEL_VALUES as readonly string[]).includes(value);
}

function normalizeModelId(model: string): string {
  return toClaudeRuntimeModelId(model).trim().toLowerCase();
}

export function isDefaultClaudeModel(model: string): boolean {
  return isClaudeModelTier(normalizeModelId(model));
}

/**
 * Resolves an effort choice within the levels Claude Code reported for the
 * model. Keeps a supported choice; otherwise defaults to `high`. Without reported levels there is no explicit effort.
 */
export function resolveSupportedEffortLevel(
  supportedLevels: readonly EffortLevel[],
  effortLevel: unknown,
): EffortLevel | null {
  if (supportedLevels.length === 0) {
    return null;
  }
  if (isEffortLevel(effortLevel) && supportedLevels.includes(effortLevel)) {
    return effortLevel;
  }
  return DEFAULT_REASONING_VALUE;
}
