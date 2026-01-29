import { serializeAgent } from '../../utils/agent';
import { parseAgentFile, parseModel, parsePermissionMode, parseToolsList } from '../agents/AgentStorage';
import type { AgentDefinition } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

export const AGENTS_PATH = '.claude/agents';

export class AgentVaultStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async loadAll(): Promise<AgentDefinition[]> {
    const agents: AgentDefinition[] = [];

    try {
      const files = await this.adapter.listFiles(AGENTS_PATH);

      for (const filePath of files) {
        if (!filePath.endsWith('.md')) continue;

        try {
          const content = await this.adapter.read(filePath);
          const parsed = parseAgentFile(content);
          if (!parsed) continue;

          const { frontmatter, body } = parsed;

          agents.push({
            id: frontmatter.name,
            name: frontmatter.name,
            description: frontmatter.description,
            prompt: body,
            tools: parseToolsList(frontmatter.tools),
            disallowedTools: parseToolsList(frontmatter.disallowedTools),
            model: parseModel(frontmatter.model),
            source: 'vault',
            skills: frontmatter.skills,
            permissionMode: parsePermissionMode(frontmatter.permissionMode),
            hooks: frontmatter.hooks,
          });
        } catch {
          // Skip malformed agent files
        }
      }
    } catch {
      // Directory may not exist yet
    }

    return agents;
  }

  async save(agent: AgentDefinition): Promise<void> {
    const filePath = `${AGENTS_PATH}/${agent.name}.md`;
    await this.adapter.write(filePath, serializeAgent(agent));
  }

  async delete(agentName: string): Promise<void> {
    const filePath = `${AGENTS_PATH}/${agentName}.md`;
    await this.adapter.delete(filePath);
  }
}
