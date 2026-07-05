import { McpServerManager } from '../../../core/mcp/McpServerManager';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceInitContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { GeminiMcpStorage } from '../storage/GeminiMcpStorage';
import { geminiSettingsTabRenderer } from '../ui/GeminiSettingsTab';

export interface GeminiWorkspaceServices extends ProviderWorkspaceServices {
  mcpServerManager: McpServerManager;
}

export async function createGeminiWorkspaceServices(context: ProviderWorkspaceInitContext): Promise<GeminiWorkspaceServices> {
  const mcpStorage = new GeminiMcpStorage(context.vaultAdapter);
  const mcpServerManager = new McpServerManager(mcpStorage);
  await mcpServerManager.loadServers();

  return {
    mcpServerManager,
    settingsTabRenderer: geminiSettingsTabRenderer,
  };
}

export const geminiWorkspaceRegistration: ProviderWorkspaceRegistration<GeminiWorkspaceServices> = {
  initialize: async (context) => createGeminiWorkspaceServices(context),
};

export function maybeGetGeminiWorkspaceServices(): GeminiWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('gemini') as GeminiWorkspaceServices | null;
}
