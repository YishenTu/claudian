/**
 * Model type definitions and constants.
 */

import { DEFAULT_REASONING_VALUE } from '../../../core/providers/reasoning';
import { toClaudeRuntimeModelId } from '../modelSelection';

/** Model identifier (string to support custom models via environment variables). */
export type ClaudeModel = string;

export const DEFAULT_CLAUDE_MODELS: { value: ClaudeModel; label: string; description: string }[] = [
  { value: 'haiku', label: 'Haiku', description: 'Fast and efficient' },
  { value: 'sonnet', label: 'Sonnet', description: 'Balanced performance' },
  { value: 'opus', label: 'Opus', description: 'Most capable' },
  { value: 'claude-fable-5', label: 'Fable 5 ($$$)', description: "Anthropic's most capable model — premium pricing above Opus" },
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
  'haiku': DEFAULT_REASONING_VALUE,
  'sonnet': DEFAULT_REASONING_VALUE,
  'opus': DEFAULT_REASONING_VALUE,
  'claude-fable-5': DEFAULT_REASONING_VALUE,
};

const ONE_M_SUFFIX = '[1m]';
const DEFAULT_MODEL_VALUES = new Set(DEFAULT_CLAUDE_MODELS.map(m => m.value.toLowerCase()));

function normalizeModelId(model: string): string {
  return toClaudeRuntimeModelId(model).trim().toLowerCase();
}

function isBuiltInFamilyVariant(model: string, family: 'sonnet' | 'opus'): boolean {
  const normalized = normalizeModelId(model);
  return normalized === family || normalized === `${family}${ONE_M_SUFFIX}`;
}

export function normalizeLegacy1MModelAlias(model: string): string {
  if (isBuiltInFamilyVariant(model, 'sonnet')) {
    return 'sonnet';
  }
  if (isBuiltInFamilyVariant(model, 'opus')) {
    return 'opus';
  }
  return model;
}

/** Fable is a standalone tier (not a haiku/sonnet/opus version bump) — always 1M context, no [1m] toggle. */
function isFableModel(model: string): boolean {
  return /claude-fable-\d+/.test(normalizeModelId(model));
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

export function isDefaultClaudeModel(model: string): boolean {
  return DEFAULT_MODEL_VALUES.has(normalizeModelId(normalizeLegacy1MModelAlias(model)));
}

/**
 * Whether the model supports the `xhigh` effort level. Supported on Opus 4.7+,
 * Sonnet 5+, and Fable — the SDK silently falls back to `high` on other models.
 */
export function supportsXHighEffort(model: string): boolean {
  const normalized = normalizeModelId(model);
  if (isBuiltInFamilyVariant(normalized, 'opus')) return true;
  if (isBuiltInFamilyVariant(normalized, 'sonnet')) return true;
  if (isFableModel(normalized)) return true;
  return (
    /claude-opus-(4-[7-9]|[5-9])/.test(normalized) ||
    /claude-sonnet-(?:[5-9]|\d{2,})(?:-\d{8})?(?:-|$)/.test(normalized)
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

  return DEFAULT_EFFORT_LEVEL[normalizeModelId(model)] ?? DEFAULT_REASONING_VALUE;
}

export function resolveEffortLevel(
  model: string,
  effortLevel: unknown,
): EffortLevel {
  return normalizeEffortLevel(model, effortLevel);
}

export const CONTEXT_WINDOW_STANDARD = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;

function isCurrentOneMillionContextModel(model: string): boolean {
  const normalized = normalizeModelId(normalizeLegacy1MModelAlias(model));
  if (normalized === 'opus' || normalized === 'sonnet' || isFableModel(normalized)) {
    return true;
  }

  const canonicalStart = normalized.indexOf('claude-');
  const canonical = canonicalStart >= 0 ? normalized.slice(canonicalStart) : normalized;
  const versionMatch = canonical.match(/^claude-(opus|sonnet)-(\d+)(?:-(\d+))?/);
  if (!versionMatch) {
    return false;
  }

  const major = Number(versionMatch[2]);
  const minor = versionMatch[3] === undefined ? 0 : Number(versionMatch[3]);
  return major > 4 || (major === 4 && minor >= 6);
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
