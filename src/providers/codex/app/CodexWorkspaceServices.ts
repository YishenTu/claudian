import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCLIResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { CodexSkillCatalog } from '../commands/CodexSkillCatalog';
import { CodexThreadArchiveService } from '../history/CodexThreadArchiveService';
import { CodexAppServerRuntime } from '../runtime/CodexAppServerRuntime';
import { CodexCLIResolver } from '../runtime/CodexCLIResolver';
import { CodexModelCatalogCoordinator } from '../runtime/CodexModelCatalogCoordinator';
import { CodexModelDiscoveryService } from '../runtime/CodexModelDiscoveryService';
import { createCodexModels } from '../runtime/CodexModels';
import { getCodexProviderSettings } from '../settings';
import { CodexSkillListingService } from '../skills/CodexSkillListingService';
import { createCodexSettingsTabRenderer } from '../ui/CodexSettingsTab';

export interface CodexWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
  cliResolver: ProviderCLIResolver;
  modelCatalogCoordinator: CodexModelCatalogCoordinator;
  runtime: CodexAppServerRuntime;
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
  const runtime = new CodexAppServerRuntime(plugin);
  const skillListProvider = options.skillListingService
    ?? new CodexSkillListingService(runtime);
  const modelCatalogCoordinator = options.modelCatalogCoordinator
    ?? new CodexModelCatalogCoordinator(
      plugin,
      new CodexModelDiscoveryService(plugin, runtime),
    );
  const commandCatalog = new CodexSkillCatalog(skillListProvider);
  const modelCatalog = createCodexModels(plugin, modelCatalogCoordinator);
  const sessionArchive = new CodexThreadArchiveService(runtime);
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('codex', {
      preserveSessions: () => getCodexProviderSettings(plugin.settings).enabled,
      beforeTransition: async () => {
        modelCatalog.beginTransition();
        modelCatalogCoordinator.beginEnvironmentTransition();
        skillListProvider.beginEnvironmentTransition();
        sessionArchive.beginEnvironmentTransition();
        await Promise.all([
          modelCatalogCoordinator.quiesceForEnvironmentChange(),
          skillListProvider.quiesceForEnvironmentChange(),
          sessionArchive.quiesceForEnvironmentChange(),
        ]);
        runtime.beginEnvironmentTransition();
      },
      afterTransition: async () => {
        try {
          await runtime.endEnvironmentTransition();
        } finally {
          modelCatalog.endTransition();
          modelCatalogCoordinator.endEnvironmentTransition();
          skillListProvider.endEnvironmentTransition();
          sessionArchive.endEnvironmentTransition();
        }
      },
    });
  let disposePromise: Promise<void> | null = null;

  const cliResolver = new CodexCLIResolver();
  return {
    commandCatalog,
    runtime,
    startRuntime: () => runtime.start(),
    onAgentSkillsChanged: () => commandCatalog.refresh(),
    cliResolver,
    modelCatalogCoordinator,
    settingsTabRenderer: createCodexSettingsTabRenderer({ cliResolver, modelCatalog }),
    modelCatalog,
    sessionArchive,
    dispose() {
      if (disposePromise) return disposePromise;
      unregisterTransitionHook();
      disposePromise = Promise.all([
        modelCatalog.dispose(),
        modelCatalogCoordinator.dispose(),
        skillListProvider.dispose(),
        sessionArchive.dispose(),
      ]).finally(() => runtime.dispose()).then(() => undefined);
      return disposePromise;
    },
  };
}

export const codexWorkspaceRegistration: ProviderWorkspaceRegistration<CodexWorkspaceServices> = {
  consumesAgentSkills: true,
  providesSessionArchive: true,
  initialize: async ({ plugin }) => createCodexWorkspaceServices(plugin),
};

export function maybeGetCodexWorkspaceServices(): CodexWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('codex') as CodexWorkspaceServices | null;
}

export function getCodexWorkspaceServices(): CodexWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('codex') as CodexWorkspaceServices;
}
