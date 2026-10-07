import type { SlashCommand } from '@/core/types';

import { type ACPAvailableCommand, normalizeACPAvailableCommands } from '../../acp';

/** Grok gives skills and legacy `commands/*.md` the same metadata; only skills point at a `SKILL.md`. */
export function normalizeGrokCommands(commands: readonly ACPAvailableCommand[]): SlashCommand[] {
  return normalizeACPAvailableCommands(commands).map((command, index) => ({
    ...command,
    kind: isSkillPath(commands[index]._meta?.path) ? 'skill' : 'command',
  }));
}

function isSkillPath(path: unknown): boolean {
  return typeof path === 'string' && /(?:^|[\\/])SKILL\.md$/.test(path);
}
