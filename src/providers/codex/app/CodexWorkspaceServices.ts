import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { HomeFileAdapter } from '../../../core/storage/HomeFileAdapter';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type ClaudianPlugin from '../../../main';
import { CodexAgentMentionProvider } from '../agents/CodexAgentMentionProvider';
import { CodexSkillCatalog } from '../commands/CodexSkillCatalog';
import { CodexSkillStorage } from '../storage/CodexSkillStorage';
import { CodexSubagentStorage } from '../storage/CodexSubagentStorage';

export interface CodexWorkspaceServices extends ProviderWorkspaceServices {
  subagentStorage: CodexSubagentStorage;
  commandCatalog: ProviderCommandCatalog;
  agentMentionProvider: CodexAgentMentionProvider;
}

export async function createCodexWorkspaceServices(
  plugin: ClaudianPlugin,
): Promise<CodexWorkspaceServices> {
  const vaultAdapter = plugin.claudeStorage.getAdapter();
  const subagentStorage = new CodexSubagentStorage(vaultAdapter);
  const agentMentionProvider = new CodexAgentMentionProvider(subagentStorage);
  await agentMentionProvider.loadAgents();

  const homeAdapter = new HomeFileAdapter();
  const commandCatalog = new CodexSkillCatalog(
    new CodexSkillStorage(
      vaultAdapter,
      homeAdapter as unknown as VaultFileAdapter,
    ),
  );

  return {
    subagentStorage,
    commandCatalog,
    agentMentionProvider,
    refreshAgentMentions: async () => {
      await agentMentionProvider.loadAgents();
    },
  };
}

export const codexWorkspaceRegistration: ProviderWorkspaceRegistration<CodexWorkspaceServices> = {
  initialize: async ({ plugin }) => createCodexWorkspaceServices(plugin),
};

export function maybeGetCodexWorkspaceServices(): CodexWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('codex') as CodexWorkspaceServices | null;
}

export function getCodexWorkspaceServices(): CodexWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('codex') as CodexWorkspaceServices;
}
