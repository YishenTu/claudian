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

export function serializeAgent(agent: AgentDefinition): string {
  const lines: string[] = ['---'];

  lines.push(`name: ${agent.name}`);
  lines.push(`description: ${yamlString(agent.description)}`);

  if (agent.tools && agent.tools.length > 0) {
    lines.push('tools:');
    for (const tool of agent.tools) {
      lines.push(`  - ${tool}`);
    }
  }

  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    lines.push('disallowedTools:');
    for (const tool of agent.disallowedTools) {
      lines.push(`  - ${tool}`);
    }
  }

  if (agent.model && agent.model !== 'inherit') {
    lines.push(`model: ${agent.model}`);
  }

  if (agent.permissionMode) {
    lines.push(`permissionMode: ${agent.permissionMode}`);
  }

  if (agent.skills && agent.skills.length > 0) {
    lines.push('skills:');
    for (const skill of agent.skills) {
      lines.push(`  - ${skill}`);
    }
  }

  if (agent.hooks !== undefined) {
    lines.push(`hooks: ${JSON.stringify(agent.hooks)}`);
  }

  lines.push('---');
  lines.push(agent.prompt);

  return lines.join('\n');
}
