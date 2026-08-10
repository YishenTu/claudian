import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';

export const LEGACY_MCP_CONFIG_PATH = '.claude/mcp.json';

export async function deleteLegacyMcpConfig(
  adapter: VaultFileAdapter,
): Promise<void> {
  await adapter.delete(LEGACY_MCP_CONFIG_PATH);
}
