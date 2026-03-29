import type { HiddenProviderCommands } from '../../types/settings';
import type { ClaudianSettings } from '../../types/settings';
import type { ProviderId } from '../types';

function normalizeHiddenCommandName(value: string): string {
  return value.trim().replace(/^[/$]+/, '');
}

export function normalizeHiddenCommandList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }

    const commandName = normalizeHiddenCommandName(item);
    if (!commandName) {
      continue;
    }

    const key = commandName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(commandName);
  }

  return normalized;
}

export function getDefaultHiddenProviderCommands(): HiddenProviderCommands {
  return {
    claude: [],
    codex: [],
  };
}

export function normalizeHiddenProviderCommands(
  value: unknown,
  legacyClaudeCommands?: unknown,
): HiddenProviderCommands {
  const defaults = getDefaultHiddenProviderCommands();

  if (!value || typeof value !== 'object') {
    return {
      ...defaults,
      claude: normalizeHiddenCommandList(legacyClaudeCommands),
    };
  }

  const candidate = value as Partial<Record<ProviderId, unknown>>;
  return {
    claude: normalizeHiddenCommandList(candidate.claude ?? legacyClaudeCommands),
    codex: normalizeHiddenCommandList(candidate.codex),
  };
}

export function getHiddenProviderCommands(
  settings: Pick<ClaudianSettings, 'hiddenProviderCommands'>,
  providerId: ProviderId,
): string[] {
  return settings.hiddenProviderCommands?.[providerId] ?? [];
}

export function getHiddenProviderCommandSet(
  settings: Pick<ClaudianSettings, 'hiddenProviderCommands'>,
  providerId: ProviderId,
): Set<string> {
  return new Set(getHiddenProviderCommands(settings, providerId).map((command) => command.toLowerCase()));
}
