import type { ProviderWorkspaceRegistration, ProviderWorkspaceServices } from '../../../core/providers/types';
import type { HomeFileAdapter } from '../../../core/storage/HomeFileAdapter';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type ClaudianPlugin from '../../../main';
import { OpencodeAgentMentionProvider } from '../agents/OpencodeAgentMentionProvider';
import { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import { opencodeSettingsTabRenderer } from '../ui/OpencodeSettingsTab';

export interface OpencodeWorkspaceServices extends ProviderWorkspaceServices {
  agentMentionProvider: OpencodeAgentMentionProvider;
  commandCatalog: OpencodeCommandCatalog;
}

export async function createOpencodeWorkspaceServices(
  _plugin: ClaudianPlugin,
  _vaultAdapter: VaultFileAdapter,
  _homeAdapter: HomeFileAdapter,
): Promise<OpencodeWorkspaceServices> {
  const agentMentionProvider = new OpencodeAgentMentionProvider();
  await agentMentionProvider.loadAgents();

  const commandCatalog = new OpencodeCommandCatalog();

  return {
    agentMentionProvider,
    commandCatalog,
    settingsTabRenderer: opencodeSettingsTabRenderer,
  };
}

export const opencodeWorkspaceRegistration: ProviderWorkspaceRegistration<OpencodeWorkspaceServices> = {
  initialize: async ({ plugin, vaultAdapter, homeAdapter }) => createOpencodeWorkspaceServices(
    plugin,
    vaultAdapter,
    homeAdapter,
  ),
};
