import type {
  ACPLoadSessionResponse,
  ACPMetadata,
  ACPModelInfo,
  ACPSessionConfigOption,
  ACPSessionConfigSelectGroup,
  ACPSessionConfigSelectOption,
  ACPSessionConfigSelectOptions,
  ACPSessionMode,
  ACPSessionModelState,
  ACPSessionModeState,
} from './types';

export function resolveACPLoadSessionId(
  response: Pick<ACPLoadSessionResponse, 'sessionId'>,
  requestedSessionId: string,
): string {
  const returnedSessionId = typeof response.sessionId === 'string' && response.sessionId.trim()
    ? response.sessionId
    : null;
  if (returnedSessionId && returnedSessionId !== requestedSessionId) {
    throw new Error('ACP session/load returned a different session id.');
  }
  return requestedSessionId;
}

export interface ACPResolvedModelInfo {
  _meta?: ACPMetadata | null;
  description?: string | null;
  id: string;
  name: string;
}

export interface ACPResolvedSessionModelState {
  _meta?: ACPMetadata | null;
  availableModels: ACPResolvedModelInfo[];
  currentModelId: string | null;
}

export interface ACPResolvedSessionModeState {
  availableModes: ACPSessionMode[];
  currentModeId: string | null;
}

export interface ACPResolvedSessionThoughtLevelState {
  availableLevels: SelectItem[];
  configId: string | null;
  currentLevel: string | null;
}

type SelectItem = { description?: string; id: string; name: string };

function flattenACPSessionConfigSelectOptions(
  options: ACPSessionConfigSelectOptions,
): ACPSessionConfigSelectOption[] {
  if (options.length === 0) {
    return [];
  }
  if (isSelectGroup(options[0])) {
    return (options as ACPSessionConfigSelectGroup[]).flatMap((group) => group.options);
  }
  return options as ACPSessionConfigSelectOption[];
}

export function extractACPSessionModelState(params: {
  configOptions?: ACPSessionConfigOption[] | null;
  models?: ACPSessionModelState | null;
}): ACPResolvedSessionModelState {
  const { items, current } = resolveSelectItems(params.configOptions, 'model');
  const metadata = params.models && '_meta' in params.models
    ? { _meta: params.models._meta }
    : {};
  if (items) {
    return { ...metadata, availableModels: items, currentModelId: current };
  }
  return {
    ...metadata,
    availableModels: params.models?.availableModels.map(normalizeACPModelInfo) ?? [],
    currentModelId: params.models?.currentModelId ?? current,
  };
}

export function extractACPSessionModeState(params: {
  configOptions?: ACPSessionConfigOption[] | null;
  modes?: ACPSessionModeState | null;
}): ACPResolvedSessionModeState {
  const { items, current } = resolveSelectItems(params.configOptions, 'mode');
  if (items) {
    return { availableModes: items, currentModeId: current };
  }
  return {
    availableModes: params.modes?.availableModes ?? [],
    currentModeId: params.modes?.currentModeId ?? current,
  };
}

export function extractACPSessionThoughtLevelState(params: {
  configOptions?: ACPSessionConfigOption[] | null;
}): ACPResolvedSessionThoughtLevelState {
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
  configOptions: ACPSessionConfigOption[] | null | undefined,
  category: 'model' | 'mode' | 'thought_level',
): { configId: string | null; current: string | null; items: SelectItem[] | null } {
  const selectOption = findSessionConfigSelectOption(configOptions, category);
  if (!selectOption) {
    return { configId: null, current: null, items: null };
  }

  const items = flattenACPSessionConfigSelectOptions(selectOption.options).map((option) => ({
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
  configOptions: ACPSessionConfigOption[] | null | undefined,
  category: 'model' | 'mode' | 'thought_level',
): Extract<ACPSessionConfigOption, { type: 'select' }> | null {
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
  option: ACPSessionConfigSelectOption | ACPSessionConfigSelectGroup,
): option is ACPSessionConfigSelectGroup {
  return 'options' in option;
}

function normalizeACPModelInfo(model: ACPModelInfo): ACPResolvedModelInfo {
  const id = model.modelId ?? model.id;
  if (id === undefined) {
    throw new Error('ACP model entry must include modelId or id');
  }

  return {
    ...('_meta' in model ? { _meta: model._meta } : {}),
    ...('description' in model ? { description: model.description } : {}),
    id,
    name: model.name,
  };
}

function normalizeComparableKey(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
