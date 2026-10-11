import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import type { SlashCommand } from '@/core/types';

import { type DeepSeekReader, isRecord } from '../remote/DeepSeekRemoteClient';

export class DeepSeekCommandCatalog extends RuntimeCommandCatalog {
  constructor() {
    super({
      dropdownConfig: { providerId: 'deepseek', triggerChars: ['/'], builtInPrefix: '/', commandPrefix: '/', skillPrefix: '/' },
      projectEntry: command => ({ ...command, providerId: 'deepseek', kind: command.kind ?? 'command', scope: 'runtime',
        source: 'sdk', isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/' }),
    });
  }
}

export async function readDeepSeekCommands(client: DeepSeekReader, sessionId: string): Promise<SlashCommand[]> {
  const [commands, skills] = await Promise.all([client.call('commands/list', { agentId: sessionId }), readDeepSeekSkills(client, sessionId)]);
  if (!Array.isArray(commands)) throw new Error('Malformed DeepSeek command catalog.');
  return [
    ...commands.filter(isRecord).filter(command => command.name === 'compact').map(command => ({
      id: 'deepseek:command:compact', name: 'compact', description: typeof command.description === 'string' ? command.description : 'Compact history', content: '', source: 'sdk' as const, kind: 'command' as const,
    })),
    ...skills,
  ];
}

/** User-invocable skills of one session's composition; saved sessions are read without activation. */
export async function readDeepSeekSkills(client: DeepSeekReader, sessionId: string): Promise<SlashCommand[]> {
  const skills = await client.call('skills/list', { request: { sessionId } });
  if (!isRecord(skills) || !Array.isArray(skills.skills)) throw new Error('Malformed DeepSeek skill catalog.');
  return skills.skills.filter(isRecord).filter(skill => typeof skill.name === 'string').map(skill => ({
    id: `deepseek:skill:${skill.name as string}`, name: skill.name as string, description: typeof skill.description === 'string' ? skill.description : '',
    content: '', source: 'sdk' as const, kind: 'skill' as const, userInvocable: true,
  }));
}
