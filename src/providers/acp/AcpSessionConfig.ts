import type {
  AcpModelInfo,
  AcpSessionConfigOption,
  AcpSessionConfigSelectGroup,
  AcpSessionConfigSelectOption,
  AcpSessionConfigSelectOptions,
  AcpSessionMode,
  AcpSessionModelState,
  AcpSessionModeState,
} from './types';

export interface AcpResolvedSessionModelState {
  availableModels: AcpModelInfo[];
  currentModelId: string | null;
}

export interface AcpResolvedSessionModeState {
  availableModes: AcpSessionMode[];
  currentModeId: string | null;
}

export interface AcpResolvedSessionThoughtLevelState {
  availableLevels: SelectItem[];
  configId: string | null;
  currentLevel: string | null;
}

type SelectItem = { description?: string; id: string; name: string };

export function flattenAcpSessionConfigSelectOptions(
  options: AcpSessionConfigSelectOptions,
): AcpSessionConfigSelectOption[] {
  if (options.length === 0) {
    return [];
  }
  if (isSelectGroup(options[0])) {
    return (options as AcpSessionConfigSelectGroup[]).flatMap((group) => group.options);
  }
  return options as AcpSessionConfigSelectOption[];
}

export function extractAcpSessionModelState(params: {
  configOptions?: AcpSessionConfigOption[] | null;
  models?: AcpSessionModelState | null;
}): AcpResolvedSessionModelState {
  const { items, current } = resolveSelectItems(params.configOptions, 'model');
  if (items) {
    return { availableModels: items, currentModelId: current };
  }
  return {
    availableModels: params.models?.availableModels ?? [],
    currentModelId: params.models?.currentModelId ?? current,
  };
}

export function extractAcpSessionModeState(params: {
  configOptions?: AcpSessionConfigOption[] | null;
  modes?: AcpSessionModeState | null;
}): AcpResolvedSessionModeState {
  const { items, current } = resolveSelectItems(params.configOptions, 'mode');
  if (items) {
    return { availableModes: items, currentModeId: current };
  }
  return {
    availableModes: params.modes?.availableModes ?? [],
    currentModeId: params.modes?.currentModeId ?? current,
  };
}

export function extractAcpSessionThoughtLevelState(params: {
  configOptions?: AcpSessionConfigOption[] | null;
}): AcpResolvedSessionThoughtLevelState {
  const { configId, items, current } = resolveSelectItems(params.configOptions, 'thought_level');
  return {
    availableLevels: items ?? [],
    configId,
    currentLevel: current,
  };
}

// `items` is null when the config option is missing or empty so callers fall back to
// the session's own metadata. `current` is always the config option's `currentValue`
// when one exists, so fallbacks can still seed a current id from it.
function resolveSelectItems(
  configOptions: AcpSessionConfigOption[] | null | undefined,
  category: 'model' | 'mode' | 'thought_level',
): { configId: string | null; current: string | null; items: SelectItem[] | null } {
  const selectOption = findSessionConfigSelectOption(configOptions, category);
  if (!selectOption) {
    return { configId: null, current: null, items: null };
  }

  const items = flattenAcpSessionConfigSelectOptions(selectOption.options).map((option) => ({
    ...(option.description ? { description: option.description } : {}),
    id: option.value,
    name: option.name,
  }));

  return {
    configId: selectOption.id,
    current: selectOption.currentValue,
    items: items.length > 0 ? items : null,
  };
}

function findSessionConfigSelectOption(
  configOptions: AcpSessionConfigOption[] | null | undefined,
  category: 'model' | 'mode' | 'thought_level',
): Extract<AcpSessionConfigOption, { type: 'select' }> | null {
  if (!configOptions) {
    return null;
  }
  // Prefer explicit `category` metadata; fall back to id-based matching for older agents
  // that have not yet migrated their config options to tag a category.
  const byCategory = configOptions.find((option) => (
    option.type === 'select' && normalizeComparableKey(option.category) === category
  ));
  if (byCategory?.type === 'select') {
    return byCategory;
  }
  const byLegacyId = configOptions.find((option) => (
    option.type === 'select' && normalizeComparableKey(option.id) === legacyConfigIdForCategory(category)
  ));
  return byLegacyId?.type === 'select' ? byLegacyId : null;
}

function legacyConfigIdForCategory(category: 'model' | 'mode' | 'thought_level'): string {
  return category === 'thought_level' ? 'effort' : category;
}

function isSelectGroup(
  option: AcpSessionConfigSelectOption | AcpSessionConfigSelectGroup,
): option is AcpSessionConfigSelectGroup {
  return 'options' in option;
}

function normalizeComparableKey(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
