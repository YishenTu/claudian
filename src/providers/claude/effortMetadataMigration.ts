import type { ClaudeDiscoveredModel } from './modelCatalog';
import { isClaudeModelTier } from './modelTiers';
import type { EffortLevel } from './types/models';

/**
 * Fixed snapshot returned by `supportedModels()` (Claude Code 2.1.280, SDK
 * 0.3.267). Used only by the one-time settings migration; runtime logic reads
 * model metadata and never falls back to these values.
 */
const VERIFIED_EFFORT_LEVELS: Readonly<Record<string, readonly EffortLevel[]>> = {
  'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** Verified selection IDs that differ from their canonical model ID. */
const VERIFIED_SELECTION_IDS: Readonly<Record<string, string>> = {
  'claude-fable-5-1[1m]': 'claude-fable-5-1',
};

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function resolveVerifiedModelId(model: ClaudeDiscoveredModel): string | null {
  if (hasOwn(VERIFIED_EFFORT_LEVELS, model.value)) {
    return model.resolvedModel === undefined || model.resolvedModel === model.value
      ? model.value
      : null;
  }
  if (hasOwn(VERIFIED_SELECTION_IDS, model.value)) {
    const canonical = VERIFIED_SELECTION_IDS[model.value];
    return model.resolvedModel === undefined || model.resolvedModel === canonical
      ? canonical
      : null;
  }
  // An alias identifies a version only through the resolved model Claude Code saved with it.
  if (isClaudeModelTier(model.value) && model.resolvedModel
    && hasOwn(VERIFIED_EFFORT_LEVELS, model.resolvedModel)) {
    return model.resolvedModel;
  }
  return null;
}

/** Fills missing or empty effort metadata for verified saved models only. */
export function migrateClaudeEffortMetadata(
  models: readonly ClaudeDiscoveredModel[],
): ClaudeDiscoveredModel[] {
  return models.map(model => {
    if (model.supportedEffortLevels && model.supportedEffortLevels.length > 0) {
      return model;
    }
    const verifiedId = resolveVerifiedModelId(model);
    return verifiedId
      ? { ...model, supportedEffortLevels: [...VERIFIED_EFFORT_LEVELS[verifiedId]] }
      : model;
  });
}
