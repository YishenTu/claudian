import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
} from '../../core/providers/reasoning';
import type { ACPSessionConfigOption, ACPSessionConfigSelectOption, ACPSessionModelState } from '../acp';

export interface AntigravityReasoningEffort {
  label: string;
  value: string;
}

export interface AntigravityModel {
  displayName: string;
  rawId: string;
  reasoningEfforts: AntigravityReasoningEffort[];
}

export const ANTIGRAVITY_MODEL_PREFIX = 'antigravity/';
export const ANTIGRAVITY_MODEL_CONFIG_ID = 'model';
export const ANTIGRAVITY_REASONING_CONFIG_ID = 'thought_level';
export const ANTIGRAVITY_MODE_CONFIG_ID = 'mode';

export function encodeAntigravityModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  if (!normalized || normalized === ANTIGRAVITY_MODEL_PREFIX) return '';
  return normalized.startsWith(ANTIGRAVITY_MODEL_PREFIX)
    ? normalized
    : `${ANTIGRAVITY_MODEL_PREFIX}${normalized}`;
}

export function decodeAntigravityModelId(model: string): string | null {
  const normalized = model.trim();
  if (!normalized.startsWith(ANTIGRAVITY_MODEL_PREFIX)) return null;
  return normalized.slice(ANTIGRAVITY_MODEL_PREFIX.length).trim() || null;
}

export function isAntigravityModelSelectionId(model: string): boolean {
  return decodeAntigravityModelId(model) !== null;
}

export function findAntigravityModel(
  models: readonly AntigravityModel[],
  modelId: string,
): AntigravityModel | null {
  const rawId = decodeAntigravityModelId(modelId) ?? modelId.trim();
  return rawId ? models.find(model => model.rawId === rawId) ?? null : null;
}

export function resolveAntigravityDefaultReasoning(
  model: AntigravityModel | null | undefined,
  preferred?: string,
): string {
  const values = model?.reasoningEfforts.map(effort => effort.value) ?? [];
  const normalized = preferred?.trim();
  if (normalized && values.includes(normalized)) return normalized;
  return values.includes(DEFAULT_REASONING_VALUE) ? DEFAULT_REASONING_VALUE : values[values.length - 1] ?? '';
}

/**
 * The session's `model` select option is agy's authoritative list of base model ids, names and the current model;
 * ACP rejects ids it did not advertise. `thought_level` covers only the current model, so each model's levels come
 * from the legacy `models` list in the same session/new or resume response, which names every model and effort as
 * one `<model>-<effort>` id; a model listed only under its own id has a fixed effort. Without that list, only the
 * current model has levels.
 */
export function readAntigravitySessionModels(
  configOptions: readonly ACPSessionConfigOption[] | null | undefined,
  sessionModels?: ACPSessionModelState | null,
): { currentModelId: string | null; models: AntigravityModel[] } {
  const modelOption = findSelectOption(configOptions, ANTIGRAVITY_MODEL_CONFIG_ID);
  if (!modelOption) return { currentModelId: null, models: [] };
  const currentModelId = modelOption.currentValue || null;
  const sessionLevels = readAntigravityThinkingLevels(configOptions);
  const baseIds = flattenSelectOptions(modelOption.options).map(option => option.value);
  const levelsByModel = sessionModels ? groupLevelsByModel(baseIds, sessionModels, sessionLevels) : null;
  return {
    currentModelId,
    models: normalizeAntigravityModels(flattenSelectOptions(modelOption.options).map(option => ({
      displayName: option.name,
      rawId: option.value,
      reasoningEfforts: levelsByModel?.get(option.value) ?? (option.value === currentModelId ? sessionLevels : []),
    }))),
  };
}

/** Thinking levels the session offers for its current model; none for a fixed-effort model. */
export function readAntigravityThinkingLevels(
  configOptions: readonly ACPSessionConfigOption[] | null | undefined,
): AntigravityReasoningEffort[] {
  return flattenSelectOptions(findSelectOption(configOptions, ANTIGRAVITY_REASONING_CONFIG_ID)?.options)
    .map(option => ({ label: option.name || formatReasoningValueLabel(option.value), value: option.value }));
}

/** Files each `<model>-<effort>` id under the longest base id it extends, ordered as agy orders its levels. */
function groupLevelsByModel(
  baseIds: readonly string[],
  sessionModels: ACPSessionModelState,
  sessionLevels: readonly AntigravityReasoningEffort[],
): Map<string, AntigravityReasoningEffort[]> {
  const byLength = [...baseIds].sort((left, right) => right.length - left.length);
  const levels = new Map<string, Set<string>>(baseIds.map(id => [id, new Set<string>()]));
  for (const { modelId } of sessionModels.availableModels ?? []) {
    if (typeof modelId !== 'string') continue;
    const base = byLength.find(id => modelId === id || modelId.startsWith(`${id}-`));
    if (base && modelId !== base) levels.get(base)!.add(modelId.slice(base.length + 1));
  }
  const order = [...sessionLevels.map(level => level.value), ...DEFAULT_LEVEL_ORDER];
  const rank = (value: string) => {
    const index = order.indexOf(value);
    return index < 0 ? order.length : index;
  };
  return new Map([...levels].map(([id, values]) => [id, [...values].sort((left, right) => rank(left) - rank(right))
    .map(value => sessionLevels.find(level => level.value === value) ?? { label: formatReasoningValueLabel(value), value })]));
}

const DEFAULT_LEVEL_ORDER = ['low', 'medium', 'high', 'extra', 'max'];

export function readAntigravityConfigValue(
  configOptions: readonly ACPSessionConfigOption[] | null | undefined,
  configId: string,
): string | null {
  return findSelectOption(configOptions, configId)?.currentValue ?? null;
}

export function normalizeAntigravityModels(value: unknown): AntigravityModel[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, AntigravityModel>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const rawId = readTrimmedString(entry.rawId);
    if (!rawId || byId.has(rawId)) continue;
    byId.set(rawId, {
      displayName: readTrimmedString(entry.displayName) || rawId,
      rawId,
      reasoningEfforts: normalizeEfforts(entry.reasoningEfforts),
    });
  }
  return [...byId.values()];
}

function normalizeEfforts(value: unknown): AntigravityReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const efforts: AntigravityReasoningEffort[] = [];
  for (const entry of value) {
    const effort = isRecord(entry) ? readTrimmedString(entry.value) : '';
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push({
      label: (isRecord(entry) && readTrimmedString(entry.label)) || formatReasoningValueLabel(effort),
      value: effort,
    });
  }
  return efforts;
}

function findSelectOption(
  configOptions: readonly ACPSessionConfigOption[] | null | undefined,
  configId: string,
): Extract<ACPSessionConfigOption, { type: 'select' }> | null {
  const option = configOptions?.find(entry => entry.id === configId);
  return option?.type === 'select' ? option : null;
}

function flattenSelectOptions(
  options: Extract<ACPSessionConfigOption, { type: 'select' }>['options'] | undefined,
): ACPSessionConfigSelectOption[] {
  return (options ?? []).flatMap(option => ('options' in option ? option.options : [option]));
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
