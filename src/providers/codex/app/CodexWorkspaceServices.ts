import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCliResolver,
  ProviderModelCatalogRefreshResult,
  ProviderTransitionOwnerContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { CodexAgentMentionProvider } from '../agents/CodexAgentMentionProvider';
import { CodexSkillCatalog } from '../commands/CodexSkillCatalog';
import { CodexCliResolver } from '../runtime/CodexCliResolver';
import { CodexModelCatalogCoordinator } from '../runtime/CodexModelCatalogCoordinator';
import { CodexModelDiscoveryService } from '../runtime/CodexModelDiscoveryService';
import { getCodexProviderSettings } from '../settings';
import { CodexSkillListingService } from '../skills/CodexSkillListingService';
import { CodexSubagentStorage } from '../storage/CodexSubagentStorage';
import { codexSettingsTabRenderer } from '../ui/CodexSettingsTab';

export interface CodexWorkspaceServices extends ProviderWorkspaceServices {
  subagentStorage: CodexSubagentStorage;
  commandCatalog: ProviderCommandCatalog;
  agentMentionProvider: CodexAgentMentionProvider;
  cliResolver: ProviderCliResolver;
  modelCatalogCoordinator: CodexModelCatalogCoordinator;
  refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): Promise<ProviderModelCatalogRefreshResult>;
  dispose(): Promise<void>;
}

export interface CodexWorkspaceServicesOptions {
  readonly modelCatalogCoordinator?: CodexModelCatalogCoordinator;
  readonly skillListingService?: CodexSkillListingService;
}

function createCodexCliResolver(): ProviderCliResolver {
  return new CodexCliResolver();
}

export async function createCodexWorkspaceServices(
  plugin: ProviderHost,
  vaultAdapter: VaultFileAdapter,
  options: CodexWorkspaceServicesOptions = {},
): Promise<CodexWorkspaceServices> {
  const subagentStorage = new CodexSubagentStorage(vaultAdapter);
  const agentMentionProvider = new CodexAgentMentionProvider(subagentStorage);

  const skillListProvider = options.skillListingService
    ?? new CodexSkillListingService(plugin);
  const modelCatalogCoordinator = options.modelCatalogCoordinator
    ?? new CodexModelCatalogCoordinator(
      plugin,
      new CodexModelDiscoveryService(plugin),
    );
  const commandCatalog = new CodexSkillCatalog(skillListProvider);
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('codex', {
      beforeTransition: async () => {
        modelCatalogCoordinator.beginEnvironmentTransition();
        skillListProvider.beginEnvironmentTransition();
        await Promise.all([
          modelCatalogCoordinator.quiesceForEnvironmentChange(),
          skillListProvider.quiesceForEnvironmentChange(),
        ]);
      },
      afterTransition: () => {
        modelCatalogCoordinator.endEnvironmentTransition();
        skillListProvider.endEnvironmentTransition();
      },
    });
  let disposePromise: Promise<void> | null = null;

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
    refreshModelCatalog: async context => modelCatalogCoordinator.refreshModelCatalog(context),
    prepareSettings: async () => agentMentionProvider.loadAgents(),
    dispose() {
      if (disposePromise) return disposePromise;
      unregisterTransitionHook();
      disposePromise = Promise.all([
        modelCatalogCoordinator.dispose(),
        skillListProvider.dispose(),
      ]).then(() => undefined);
      return disposePromise;
    },
  };
}

export const codexWorkspaceRegistration: ProviderWorkspaceRegistration<CodexWorkspaceServices> = {
  initialize: async ({ plugin, vaultAdapter }) => createCodexWorkspaceServices(
    plugin,
    vaultAdapter,
  ),
};

export function maybeGetCodexWorkspaceServices(): CodexWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('codex') as CodexWorkspaceServices | null;
}

export function getCodexWorkspaceServices(): CodexWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('codex') as CodexWorkspaceServices;
}
