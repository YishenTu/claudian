import type {
  AcpSessionConfigOption,
  AcpSessionModeState,
} from '../acp';
import { flattenOpencodeSelectOptions } from './configOptions';

export interface OpencodeMode {
  description?: string;
  id: string;
  name: string;
}

export interface OpencodeSessionModeState {
  availableModes: OpencodeMode[];
  currentModeId: string | null;
}

export const OPENCODE_FALLBACK_MODES: ReadonlyArray<OpencodeMode> = Object.freeze([
  {
    description: 'The default agent. Executes tools based on configured permissions.',
    id: 'build',
    name: 'build',
  },
  {
    description: 'Plan mode. Disallows all edit tools.',
    id: 'plan',
    name: 'plan',
  },
]);

export function normalizeOpencodeAvailableModes(value: unknown): OpencodeMode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: OpencodeMode[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : id;
    const description = typeof entry.description === 'string'
      ? entry.description.trim()
      : '';

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push({
      ...(description ? { description } : {}),
      id,
      name: name || id,
    });
  }

  return normalized;
}

export function getEffectiveOpencodeModes(modes: OpencodeMode[]): OpencodeMode[] {
  return modes.length > 0 ? modes : [...OPENCODE_FALLBACK_MODES];
}

export function getOpencodeToolbarModes(modes: OpencodeMode[]): OpencodeMode[] {
  const effectiveModes = getEffectiveOpencodeModes(modes);
  const toolbarModes = effectiveModes.filter((mode) => mode.id === 'build' || mode.id === 'plan');
  return toolbarModes.length > 0 ? toolbarModes : effectiveModes;
}

export function normalizeOpencodeSelectedMode(
  value: unknown,
): string {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed;
}

export function extractOpencodeSessionModeState(params: {
  configOptions?: AcpSessionConfigOption[] | null;
  modes?: AcpSessionModeState | null;
}): OpencodeSessionModeState {
  const fromConfig = extractFromConfigOptions(params.configOptions ?? null);
  if (fromConfig.availableModes.length > 0) {
    return fromConfig;
  }

  return {
    availableModes: normalizeOpencodeAvailableModes(params.modes?.availableModes ?? []),
    currentModeId: params.modes?.currentModeId ?? null,
  };
}

function extractFromConfigOptions(
  configOptions: AcpSessionConfigOption[] | null,
): OpencodeSessionModeState {
  const modeOption = configOptions?.find((option) => option.id === 'mode' && option.type === 'select');
  if (!modeOption || modeOption.type !== 'select') {
    return {
      availableModes: [],
      currentModeId: null,
    };
  }

  return {
    availableModes: normalizeOpencodeAvailableModes(
      flattenOpencodeSelectOptions(modeOption.options).map((option) => ({
        description: option.description ?? undefined,
        id: option.value,
        name: option.name,
      })),
    ),
    currentModeId: modeOption.currentValue,
  };
}
