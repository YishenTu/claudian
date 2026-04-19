import type {
  AcpSessionConfigOption,
  AcpSessionConfigSelectGroup,
  AcpSessionConfigSelectOption,
  AcpSessionConfigSelectOptions,
  AcpSessionModelState,
} from '../acp';

export interface OpencodeDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface OpencodeSessionModelState {
  currentRawModelId: string | null;
  discoveredModels: OpencodeDiscoveredModel[];
}

export interface OpencodeDiscoveredModelGroup {
  models: OpencodeDiscoveredModel[];
  providerKey: string;
  providerLabel: string;
}

export const OPENCODE_SYNTHETIC_MODEL_ID = 'opencode';

const OPENCODE_MODEL_PREFIX = 'opencode:';

export function isOpencodeModelSelectionId(model: string): boolean {
  return model === OPENCODE_SYNTHETIC_MODEL_ID || model.startsWith(OPENCODE_MODEL_PREFIX);
}

export function encodeOpencodeModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${OPENCODE_MODEL_PREFIX}${normalized}` : OPENCODE_SYNTHETIC_MODEL_ID;
}

export function decodeOpencodeModelId(model: string): string | null {
  if (model.startsWith(OPENCODE_MODEL_PREFIX)) {
    const rawModelId = model.slice(OPENCODE_MODEL_PREFIX.length).trim();
    return rawModelId || null;
  }

  return model === OPENCODE_SYNTHETIC_MODEL_ID ? null : null;
}

export function normalizeOpencodeDiscoveredModels(value: unknown): OpencodeDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: OpencodeDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const rawId = typeof entry.rawId === 'string' ? entry.rawId.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : rawId;
    const description = typeof entry.description === 'string'
      ? entry.description.trim()
      : '';

    if (!rawId || seen.has(rawId)) {
      continue;
    }

    seen.add(rawId);
    normalized.push({
      ...(description ? { description } : {}),
      label: label || rawId,
      rawId,
    });
  }

  return normalized;
}

export function splitOpencodeModelLabel(label: string): {
  modelLabel: string;
  providerLabel: string;
} {
  const trimmed = label.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return {
      modelLabel: trimmed,
      providerLabel: 'Other',
    };
  }

  return {
    modelLabel: trimmed.slice(slashIndex + 1).trim(),
    providerLabel: trimmed.slice(0, slashIndex).trim(),
  };
}

export function groupOpencodeDiscoveredModels(
  models: OpencodeDiscoveredModel[],
): OpencodeDiscoveredModelGroup[] {
  const groups = new Map<string, OpencodeDiscoveredModelGroup>();
  for (const model of models) {
    const { providerLabel } = splitOpencodeModelLabel(model.label || model.rawId);
    const providerKey = providerLabel.toLowerCase();
    const existing = groups.get(providerKey);
    if (existing) {
      existing.models.push(model);
      continue;
    }

    groups.set(providerKey, {
      models: [model],
      providerKey,
      providerLabel,
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      models: [...group.models].sort((left, right) => left.label.localeCompare(right.label)),
    }))
    .sort((left, right) => left.providerLabel.localeCompare(right.providerLabel));
}

export function extractOpencodeSessionModelState(params: {
  configOptions?: AcpSessionConfigOption[] | null;
  models?: AcpSessionModelState | null;
}): OpencodeSessionModelState {
  const fromConfig = extractFromConfigOptions(params.configOptions ?? null);
  if (fromConfig.discoveredModels.length > 0) {
    return fromConfig;
  }

  return {
    currentRawModelId: params.models?.currentModelId ?? null,
    discoveredModels: normalizeOpencodeDiscoveredModels(
      params.models?.availableModels.map((model) => ({
        description: model.description ?? undefined,
        label: model.name,
        rawId: model.id,
      })) ?? [],
    ),
  };
}

function extractFromConfigOptions(
  configOptions: AcpSessionConfigOption[] | null,
): OpencodeSessionModelState {
  const modelOption = configOptions?.find((option) => option.id === 'model' && option.type === 'select');
  if (!modelOption || modelOption.type !== 'select') {
    return {
      currentRawModelId: null,
      discoveredModels: [],
    };
  }

  return {
    currentRawModelId: modelOption.currentValue,
    discoveredModels: normalizeOpencodeDiscoveredModels(
      flattenSelectOptions(modelOption.options).map((option) => ({
        description: option.description ?? undefined,
        label: option.name,
        rawId: option.value,
      })),
    ),
  };
}

function flattenSelectOptions(options: AcpSessionConfigSelectOptions): AcpSessionConfigSelectOption[] {
  if (options.length === 0) {
    return [];
  }

  const first = options[0];
  if (isSelectGroup(first)) {
    return (options as AcpSessionConfigSelectGroup[]).flatMap((group) => group.options);
  }

  return options as AcpSessionConfigSelectOption[];
}

function isSelectGroup(
  option: AcpSessionConfigSelectOption | AcpSessionConfigSelectGroup,
): option is AcpSessionConfigSelectGroup {
  return 'options' in option;
}
