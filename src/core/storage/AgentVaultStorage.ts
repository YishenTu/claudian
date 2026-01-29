import { serializeAgent } from '../../utils/agent';
import { buildAgentFromFrontmatter, parseAgentFile } from '../agents/AgentStorage';
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

          agents.push(buildAgentFromFrontmatter(frontmatter, body, {
            id: frontmatter.name,
            source: 'vault',
            filePath,
          }));
        } catch { /* Non-critical: skip malformed agent files */ }
      }
    } catch { /* Non-critical: directory may not exist yet */ }

    return agents;
  }

  async save(agent: AgentDefinition): Promise<void> {
    await this.adapter.write(this.resolvePath(agent), serializeAgent(agent));
  }

  async delete(agent: AgentDefinition): Promise<void> {
    await this.adapter.delete(this.resolvePath(agent));
  }

  private resolvePath(agent: AgentDefinition): string {
    return agent.filePath ?? `${AGENTS_PATH}/${agent.name}.md`;
  }
}
