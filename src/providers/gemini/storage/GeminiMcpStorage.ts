import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import type { ManagedMcpServer } from '../../../core/types';
import type { AppMcpStorage } from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';

export class GeminiMcpStorage implements AppMcpStorage {
  private mcpPath: string;

  constructor(vaultAdapter: VaultFileAdapter) {
    this.mcpPath = path.join(vaultAdapter.getBasePath(), '.gemini', 'mcp.json');
  }

  async load(): Promise<ManagedMcpServer[]> {
    try {
      const content = await fs.readFile(this.mcpPath, 'utf-8');
      const data = JSON.parse(content);
      return data?.mcpServers ? data.mcpServers : [];
    } catch {
      return [];
    }
  }

  async save(servers: ManagedMcpServer[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.mcpPath), { recursive: true });
      await fs.writeFile(this.mcpPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8');
    } catch {
      // Ignore
    }
  }
}
