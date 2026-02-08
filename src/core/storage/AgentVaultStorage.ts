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

  async load(agent: AgentDefinition): Promise<AgentDefinition | null> {
    const filePath = this.resolvePath(agent);
    try {
      const content = await this.adapter.read(filePath);
      const parsed = parseAgentFile(content);
      if (!parsed) return null;
      const { frontmatter, body } = parsed;
      return buildAgentFromFrontmatter(frontmatter, body, {
        id: frontmatter.name,
        source: agent.source,
        filePath,
      });
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async save(agent: AgentDefinition): Promise<void> {
    await this.adapter.write(this.resolvePath(agent), serializeAgent(agent));
  }

  async delete(agent: AgentDefinition): Promise<void> {
    await this.adapter.delete(this.resolvePath(agent));
  }

  private resolvePath(agent: AgentDefinition): string {
    if (!agent.filePath) {
      return `${AGENTS_PATH}/${agent.name}.md`;
    }

    const normalized = agent.filePath.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf(`${AGENTS_PATH}/`);
    if (idx !== -1) {
      return normalized.slice(idx);
    }
    return `${AGENTS_PATH}/${agent.name}.md`;
  }

  private isFileNotFoundError(error: unknown): boolean {
    if (!error) return false;

    if (typeof error === 'string') {
      return /enoent|not found|no such file/i.test(error);
    }

    if (typeof error === 'object') {
      const maybeCode = (error as { code?: unknown }).code;
      if (typeof maybeCode === 'string' && /enoent|not.?found/i.test(maybeCode)) {
        return true;
      }

      const maybeMessage = (error as { message?: unknown }).message;
      if (typeof maybeMessage === 'string' && /enoent|not found|no such file/i.test(maybeMessage)) {
        return true;
      }
    }

    return false;
  }
}
