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
import { CodexSkillCatalog } from '../commands/CodexSkillCatalog';
import { CodexCliResolver } from '../runtime/CodexCliResolver';
import { CodexModelCatalogCoordinator } from '../runtime/CodexModelCatalogCoordinator';
import { CodexModelDiscoveryService } from '../runtime/CodexModelDiscoveryService';
import { getCodexProviderSettings } from '../settings';
import { CodexSkillListingService } from '../skills/CodexSkillListingService';
import { createCodexSettingsTabRenderer } from '../ui/CodexSettingsTab';

export interface CodexWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
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

export async function createCodexWorkspaceServices(
  plugin: ProviderHost,
  options: CodexWorkspaceServicesOptions = {},
): Promise<CodexWorkspaceServices> {
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

  const cliResolver = new CodexCliResolver();
  return {
    commandCatalog,
    cliResolver,
    modelCatalogCoordinator,
    settingsTabRenderer: createCodexSettingsTabRenderer({ cliResolver, modelCatalogCoordinator, refreshModelCatalog: context => modelCatalogCoordinator.refreshModelCatalog(context) }),
    refreshModelCatalog: async context => modelCatalogCoordinator.refreshModelCatalog(context),
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
  initialize: async ({ plugin }) => createCodexWorkspaceServices(plugin),
};

export function maybeGetCodexWorkspaceServices(): CodexWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('codex') as CodexWorkspaceServices | null;
}

export function getCodexWorkspaceServices(): CodexWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('codex') as CodexWorkspaceServices;
}
