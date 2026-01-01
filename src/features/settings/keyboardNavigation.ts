import type { KeyboardNavigationSettings } from '@/core/types/settings';

const NAV_ACTIONS = ['scrollUp', 'scrollDown', 'focusInput'] as const;
type NavAction = (typeof NAV_ACTIONS)[number];

export const buildNavMappingText = (settings: KeyboardNavigationSettings): string => {
  return [
    `map ${settings.scrollUpKey} scrollUp`,
    `map ${settings.scrollDownKey} scrollDown`,
    `map ${settings.focusInputKey} focusInput`,
  ].join('\n');
};

export const parseNavMappings = (
  value: string
): { settings?: Record<NavAction, string>; error?: string } => {
  const parsed: Partial<Record<NavAction, string>> = {};
  const usedKeys = new Map<string, string>();
  const lines = value.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    if (parts.length !== 3 || parts[0] !== 'map') {
      return { error: 'Each line must follow "map <key> <action>"' };
    }

    const key = parts[1];
    const action = parts[2] as NavAction;

    if (!NAV_ACTIONS.includes(action)) {
      return { error: `Unknown action: ${parts[2]}` };
    }

    if (key.length !== 1) {
      return { error: `Key must be a single character for ${action}` };
    }

    const normalizedKey = key.toLowerCase();
    if (usedKeys.has(normalizedKey)) {
      return { error: 'Navigation keys must be unique' };
    }

    if (parsed[action]) {
      return { error: `Duplicate mapping for ${action}` };
    }

    usedKeys.set(normalizedKey, action);
    parsed[action] = key;
  }

  const missing = NAV_ACTIONS.filter((action) => !parsed[action]);
  if (missing.length > 0) {
    return { error: `Missing mapping for ${missing.join(', ')}` };
  }

  return { settings: parsed as Record<NavAction, string> };
};
