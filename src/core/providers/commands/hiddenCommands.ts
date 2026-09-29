import type { ClaudianSettings } from '../../types/settings';

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

/**
 * Reads the global hidden-command list, folding the retired per-provider map
 * into it when the global list has never been stored.
 */
export function migrateHiddenCommands(stored: Record<string, unknown>): string[] {
  if (Object.prototype.hasOwnProperty.call(stored, 'hiddenCommands')) {
    return normalizeHiddenCommandList(stored.hiddenCommands);
  }
  const legacy = stored.hiddenProviderCommands;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return [];
  }
  return normalizeHiddenCommandList(
    Object.values(legacy as Record<string, unknown>).flatMap((commands): unknown[] => (
      Array.isArray(commands) ? commands as unknown[] : []
    )),
  );
}

export function getHiddenCommandSet(
  settings: Pick<ClaudianSettings, 'hiddenCommands'>,
): Set<string> {
  return new Set((settings.hiddenCommands ?? []).map(command => command.toLowerCase()));
}
