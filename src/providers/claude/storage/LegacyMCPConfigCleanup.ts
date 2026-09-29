import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';

const LEGACY_MCP_CONFIG_PATH = '.claude/mcp.json';

export async function deleteLegacyMCPConfig(
  adapter: VaultFileAdapter,
): Promise<void> {
  await adapter.delete(LEGACY_MCP_CONFIG_PATH);
}
