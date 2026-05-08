import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { GeminiAgentMentionProvider } from '../agents/GeminiAgentMentionProvider';
import { GeminiCommandCatalog } from '../commands/GeminiCommandCatalog';
import { GeminiCliResolver } from '../runtime/GeminiCliResolver';
import { GeminiAgentStorage } from '../storage/GeminiAgentStorage';
import { geminiSettingsTabRenderer } from '../ui/GeminiSettingsTab';
import { GeminiRuntimeCommandLoader } from './GeminiRuntimeCommandLoader';

export interface GeminiWorkspaceServices extends ProviderWorkspaceServices {
  agentStorage: GeminiAgentStorage;
  agentMentionProvider: GeminiAgentMentionProvider;
  commandCatalog: ProviderCommandCatalog;
}

const geminiTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createGeminiWorkspaceServices(
  vaultAdapter: VaultFileAdapter,
): Promise<GeminiWorkspaceServices> {
  const agentStorage = new GeminiAgentStorage(vaultAdapter);
  const agentMentionProvider = new GeminiAgentMentionProvider(agentStorage);
  await agentMentionProvider.loadAgents();

  return {
    agentStorage,
    agentMentionProvider,
    commandCatalog: new GeminiCommandCatalog(),
    cliResolver: new GeminiCliResolver(),
    runtimeCommandLoader: new GeminiRuntimeCommandLoader(),
    settingsTabRenderer: geminiSettingsTabRenderer,
    tabWarmupPolicy: geminiTabWarmupPolicy,
    refreshAgentMentions: async () => {
      await agentMentionProvider.loadAgents();
    },
  };
}

export const geminiWorkspaceRegistration: ProviderWorkspaceRegistration<GeminiWorkspaceServices> = {
  initialize: async ({ vaultAdapter }) => createGeminiWorkspaceServices(vaultAdapter),
};

export function maybeGetGeminiWorkspaceServices(): GeminiWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('gemini') as GeminiWorkspaceServices | null;
}
