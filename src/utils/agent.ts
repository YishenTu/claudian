import type { AgentDefinition } from '../core/types';
import { yamlString } from './slashCommand';

const MAX_AGENT_NAME_LENGTH = 64;
const AGENT_NAME_PATTERN = /^[a-z0-9-]+$/;

export function validateAgentName(name: string): string | null {
  if (!name) {
    return 'Agent name is required';
  }
  if (name.length > MAX_AGENT_NAME_LENGTH) {
    return `Agent name must be ${MAX_AGENT_NAME_LENGTH} characters or fewer`;
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    return 'Agent name can only contain lowercase letters, numbers, and hyphens';
  }
  return null;
}

function pushYamlList(lines: string[], key: string, items?: string[]): void {
  if (!items || items.length === 0) return;
  lines.push(`${key}:`);
  for (const item of items) {
    lines.push(`  - ${item}`);
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

  lines.push('---');
  lines.push(agent.prompt);

  return lines.join('\n');
}
