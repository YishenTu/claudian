import type { ManagedMcpServer } from '../../../core/types';
import type { AppMcpStorage } from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';

export const GEMINI_MCP_CONFIG_PATH = '.gemini/mcp.json';

export class GeminiMcpStorage implements AppMcpStorage {
  constructor(private vaultAdapter: VaultFileAdapter) {}

  async load(): Promise<ManagedMcpServer[]> {
    try {
      if (!(await this.vaultAdapter.exists(GEMINI_MCP_CONFIG_PATH))) {
        return [];
      }
      const content = await this.vaultAdapter.read(GEMINI_MCP_CONFIG_PATH);
      const data = JSON.parse(content);
      return data?.mcpServers ? data.mcpServers : [];
    } catch {
      return [];
    }
  }

  async save(servers: ManagedMcpServer[]): Promise<void> {
    try {
      await this.vaultAdapter.write(GEMINI_MCP_CONFIG_PATH, JSON.stringify({ mcpServers: servers }, null, 2));
    } catch {
      // Ignore
    }
  }
}
