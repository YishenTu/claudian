import type { AgentDefinition } from '../core/types';
import { validateSlugName } from './frontmatter';
import { yamlString } from './slashCommand';

export function validateAgentName(name: string): string | null {
  return validateSlugName(name, 'Agent');
}

function pushYamlList(lines: string[], key: string, items?: string[]): void {
  if (!items || items.length === 0) return;
  lines.push(`${key}:`);
  for (const item of items) {
    lines.push(`  - ${yamlString(item)}`);
  }
}

export function serializeAgent(agent: AgentDefinition): string {
  const lines: string[] = ['---'];

  lines.push(`name: ${agent.name}`);
  lines.push(`description: ${yamlString(agent.description)}`);

  pushYamlList(lines, 'tools', agent.tools);
  pushYamlList(lines, 'disallowedTools', agent.disallowedTools);

  if (agent.model && agent.model !== 'inherit') {
    lines.push(`model: ${agent.model}`);
  }

  if (agent.permissionMode) {
    lines.push(`permissionMode: ${agent.permissionMode}`);
  }

  pushYamlList(lines, 'skills', agent.skills);

  if (agent.hooks !== undefined) {
    lines.push(`hooks: ${JSON.stringify(agent.hooks)}`);
  }

  if (agent.extraFrontmatter) {
    for (const [key, value] of Object.entries(agent.extraFrontmatter)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  lines.push('---');
  lines.push(agent.prompt);

  return lines.join('\n');
}
