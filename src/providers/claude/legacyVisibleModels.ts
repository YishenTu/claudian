import { parseEnvironmentVariables } from '@/core/process/env';

import { DEFAULT_CLAUDE_MODELS } from './types/models';

/**
 * Model keys earlier versions read from the environment to seed an unset Claude selection.
 * Load-time migration only (added 2026-11-13; remove after 2027-02-13): Claudian no longer reads them.
 */
const LEGACY_CLAUDE_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
] as const;

/**
 * The selection an unset stored `visibleModels` resolved to before Claudian stopped reading model
 * environment keys: the configured model keys (or the defaults when none is set) plus the retired
 * manual `customModels` list. Persisting it once keeps that selection after the keys are removed.
 */
export function resolveLegacyClaudeVisibleModelIds(
  config: Readonly<Record<string, unknown>>,
  environmentText: string,
): string[] {
  const environment = parseEnvironmentVariables(environmentText);
  const environmentIds = LEGACY_CLAUDE_MODEL_ENV_KEYS.flatMap(key => environment[key] ? [environment[key]] : []);
  const manualModels = config.customModels;
  return [...new Set([
    ...(environmentIds.length ? environmentIds : DEFAULT_CLAUDE_MODELS.map(model => model.value)),
    ...(typeof manualModels === 'string' ? manualModels.split(/\r?\n/).map(id => id.trim()).filter(Boolean) : []),
  ])];
}
