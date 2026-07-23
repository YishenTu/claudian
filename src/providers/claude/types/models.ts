/**
 * Model type definitions and constants.
 */

import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
} from '../../../core/providers/reasoning';
import { toClaudeRuntimeModelId } from '../modelSelection';
import {
  CLAUDE_MODEL_TIER_DEFINITIONS,
  CLAUDE_MODEL_TIER_PATTERN,
  type ClaudeModelTier,
  getClaudeModelTierDefinition,
  isVersionAtLeast,
  resolveClaudeModelTierAlias,
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

const EFFORT_LEVEL_VALUES: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LEVELS: { value: EffortLevel; label: string }[] =
  EFFORT_LEVEL_VALUES.map(value => ({
    value,
    label: formatReasoningValueLabel(value),
  }));

/** Default effort level per model tier. */
export const DEFAULT_EFFORT_LEVEL: Record<string, EffortLevel> = Object.fromEntries(
  CLAUDE_MODEL_TIER_DEFINITIONS.map(definition => [definition.id, DEFAULT_REASONING_VALUE]),
);

function normalizeModelId(model: string): string {
  return toClaudeRuntimeModelId(model).trim().toLowerCase();
}

export function normalizeLegacyClaudeModelAlias(model: string): string {
  return resolveClaudeModelTierAlias(normalizeModelId(model)) ?? model;
}

interface VersionedClaudeModel {
  tier: ClaudeModelTier;
  major: number;
  minor: number;
}

function parseVersionedClaudeModel(model: string): VersionedClaudeModel | null {
  const normalized = normalizeModelId(model);
  const canonicalStart = normalized.indexOf('claude-');
  const canonical = canonicalStart >= 0 ? normalized.slice(canonicalStart) : normalized;
  const match = canonical.match(
    new RegExp(`^claude-(${CLAUDE_MODEL_TIER_PATTERN})-(\\d+)(?:-(\\d+))?`),
  );
  if (!match) {
    return null;
  }

  return {
    tier: match[1] as ClaudeModelTier,
    major: Number(match[2]),
    minor: match[3] === undefined ? 0 : Number(match[3]),
  };
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

  const normalizedModel = normalizeLegacyClaudeModelAlias(normalizeModelId(model));
  const matchingLimits = Object.entries(customLimits)
    .filter(([key, limit]) =>
      key !== model
      && normalizeLegacyClaudeModelAlias(normalizeModelId(key)) === normalizedModel
      && isValidContextLimit(limit)
    )
    .map(([, limit]) => limit);

  return matchingLimits.length === 1 ? matchingLimits[0] : null;
}

export function isDefaultClaudeModel(model: string): boolean {
  return resolveClaudeModelTierAlias(normalizeModelId(model)) !== null;
}

/**
 * Whether the model supports the `xhigh` effort level. Known Claude models use
 * their versioned capability boundary. Opaque custom models are assumed to
 * support it because their gateway capabilities cannot be inferred locally.
 */
export function supportsXHighEffort(model: string): boolean {
  const normalized = normalizeModelId(model);
  const aliasTier = resolveClaudeModelTierAlias(normalized);
  if (aliasTier) {
    return getClaudeModelTierDefinition(aliasTier).aliasSupportsXHigh;
  }

  const versionedModel = parseVersionedClaudeModel(normalized);
  if (!versionedModel) {
    return true;
  }
  const definition = getClaudeModelTierDefinition(versionedModel.tier);
  return isVersionAtLeast(
    versionedModel.major,
    versionedModel.minor,
    definition.versionedXHighFrom,
  );
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

  const modelTier = resolveClaudeModelTierAlias(normalizeModelId(model));
  return (modelTier && DEFAULT_EFFORT_LEVEL[modelTier]) ?? DEFAULT_REASONING_VALUE;
}

export function resolveEffortLevel(
  model: string,
  effortLevel: unknown,
): EffortLevel {
  return normalizeEffortLevel(model, effortLevel);
}

export const CONTEXT_WINDOW_STANDARD = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;

export type ContextWindowSource = 'custom' | 'runtime' | 'model-default';

export interface ContextWindowResolution {
  contextWindow: number;
  source: ContextWindowSource;
}

function isCurrentOneMillionContextModel(model: string): boolean {
  const normalized = normalizeModelId(model);
  const aliasTier = resolveClaudeModelTierAlias(normalized);
  if (aliasTier) {
    return getClaudeModelTierDefinition(aliasTier).aliasHasOneMillionContext;
  }

  const versionedModel = parseVersionedClaudeModel(normalized);
  if (!versionedModel) {
    return false;
  }
  const definition = getClaudeModelTierDefinition(versionedModel.tier);
  return isVersionAtLeast(
    versionedModel.major,
    versionedModel.minor,
    definition.versionedOneMillionContextFrom,
  );
}

export function getContextWindowSize(
  model: string,
  customLimits?: Record<string, number>
): number {
  const customLimit = resolveCustomContextLimit(model, customLimits);
  if (customLimit !== null) {
    return customLimit;
  }

  if (isCurrentOneMillionContextModel(model)) {
    return CONTEXT_WINDOW_1M;
  }

  return CONTEXT_WINDOW_STANDARD;
}

export function resolveContextWindowSize(
  model: string,
  customLimits?: Record<string, number>,
  runtimeContextWindow?: number,
): ContextWindowResolution {
  // Explicit overrides describe custom gateway capabilities that the Claude runtime may not recognize.
  const customLimit = resolveCustomContextLimit(model, customLimits);
  if (customLimit !== null) {
    return { contextWindow: customLimit, source: 'custom' };
  }

  if (isValidContextLimit(runtimeContextWindow)) {
    // The SDK can under-report a 1M-context model's window as the 200k standard
    // window (issue #924), which pinned the context meter at "approaching limit"
    // for context that plainly exceeds 200k. A runtime value must never shrink a
    // known-larger model default; trust it only when it meets or exceeds it.
    const modelDefault = getContextWindowSize(model);
    if (runtimeContextWindow >= modelDefault) {
      return { contextWindow: runtimeContextWindow, source: 'runtime' };
    }
  }

  return {
    contextWindow: getContextWindowSize(model),
    source: 'model-default',
  };
}
