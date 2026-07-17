import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCliResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { HomeFileAdapter } from '../../../core/storage/HomeFileAdapter';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { getVaultPath } from '../../../utils/path';
import { CodexAgentMentionProvider } from '../agents/CodexAgentMentionProvider';
import { CodexSkillCatalog } from '../commands/CodexSkillCatalog';
import { CodexCliResolver } from '../runtime/CodexCliResolver';
import { CodexModelCatalogCoordinator } from '../runtime/CodexModelCatalogCoordinator';
import { CodexModelDiscoveryService } from '../runtime/CodexModelDiscoveryService';
import { getCodexProviderSettings } from '../settings';
import { CodexSkillListingService } from '../skills/CodexSkillListingService';
import { CodexSkillStorage } from '../storage/CodexSkillStorage';
import { CodexSubagentStorage } from '../storage/CodexSubagentStorage';
import { codexSettingsTabRenderer } from '../ui/CodexSettingsTab';

export interface CodexWorkspaceServices extends ProviderWorkspaceServices {
  subagentStorage: CodexSubagentStorage;
  commandCatalog: ProviderCommandCatalog;
  agentMentionProvider: CodexAgentMentionProvider;
  cliResolver: ProviderCliResolver;
  modelCatalogCoordinator: CodexModelCatalogCoordinator;
}

function createCodexCliResolver(): ProviderCliResolver {
  return new CodexCliResolver();
}

export async function createCodexWorkspaceServices(
  plugin: ProviderHost,
  vaultAdapter: VaultFileAdapter,
  homeAdapter: HomeFileAdapter,
): Promise<CodexWorkspaceServices> {
  const subagentStorage = new CodexSubagentStorage(vaultAdapter);
  const agentMentionProvider = new CodexAgentMentionProvider(subagentStorage);

  const skillListProvider = new CodexSkillListingService(plugin);
  const modelDiscovery = new CodexModelDiscoveryService(plugin);
  const modelCatalogCoordinator = new CodexModelCatalogCoordinator(plugin, modelDiscovery);
  const commandCatalog = new CodexSkillCatalog(
    new CodexSkillStorage(
      vaultAdapter,
      homeAdapter,
    ),
    skillListProvider,
    getVaultPath(plugin.app),
  );

  if (getCodexProviderSettings(plugin.settings).enabled) {
    plugin.app.workspace.onLayoutReady(() => {
      void modelCatalogCoordinator.ensureFresh('layout-ready');
    });
  }

  return {
    subagentStorage,
    commandCatalog,
    agentMentionProvider,
    cliResolver: createCodexCliResolver(),
    modelCatalogCoordinator,
    settingsTabRenderer: codexSettingsTabRenderer,
    refreshAgentMentions: async () => {
      await agentMentionProvider.loadAgents();
    },
    refreshModelCatalog: async () => modelCatalogCoordinator.refreshModelCatalog(),
    prepareSettings: async () => agentMentionProvider.loadAgents(),
    dispose: () => modelCatalogCoordinator.cancel(),
  };
}

export const codexWorkspaceRegistration: ProviderWorkspaceRegistration<CodexWorkspaceServices> = {
  initialize: async ({ plugin, vaultAdapter, homeAdapter }) => createCodexWorkspaceServices(
    plugin,
    vaultAdapter,
    homeAdapter,
  ),
};

export function maybeGetCodexWorkspaceServices(): CodexWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('codex') as CodexWorkspaceServices | null;
}

export function getCodexWorkspaceServices(): CodexWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('codex') as CodexWorkspaceServices;
}
