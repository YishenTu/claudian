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
  return {};
}

export function normalizeHiddenProviderCommands(
  value: unknown,
  legacyClaudeCommands?: unknown,
): HiddenProviderCommands {
  const defaults = getDefaultHiddenProviderCommands();

  if (!value || typeof value !== 'object') {
    return {
      ...defaults,
      ...(normalizeHiddenCommandList(legacyClaudeCommands).length > 0
        ? { claude: normalizeHiddenCommandList(legacyClaudeCommands) }
        : {}),
    };
  }

  const candidate = value as Partial<Record<ProviderId | string, unknown>>;
  const normalized: HiddenProviderCommands = {};

  for (const [providerId, commands] of Object.entries(candidate)) {
    const next = normalizeHiddenCommandList(commands);
    if (next.length > 0) {
      normalized[providerId] = next;
    }
  }

  const legacyCommands = normalizeHiddenCommandList(legacyClaudeCommands);
  if (legacyCommands.length > 0 && !normalized.claude) {
    normalized.claude = legacyCommands;
  }

  return normalized;
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
