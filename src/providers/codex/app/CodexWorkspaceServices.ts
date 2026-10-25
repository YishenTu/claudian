import { Notice } from 'obsidian';

import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import { getProviderConfig, setProviderConfig } from '../../../core/providers/providerConfig';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCLIResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { CodexCommandCatalog } from '../commands/CodexCommandCatalog';
import { decodeCodexConfig } from '../config';
import { CodexThreadArchiveService } from '../history/CodexThreadArchiveService';
import { CodexAppServerRuntime } from '../runtime/CodexAppServerRuntime';
import { CodexCLIResolver } from '../runtime/CodexCLIResolver';
import {
  type CodexModelCatalogCommit,
  CodexModelCatalogCoordinator,
} from '../runtime/CodexModelCatalogCoordinator';
import { CodexModelDiscoveryService } from '../runtime/CodexModelDiscoveryService';
import { createCodexModels } from '../runtime/CodexModels';
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

/**
 * Commits a Codex catalog update in one settings transaction with the application's
 * model-selection normalization, which may change any provider's selections. A
 * rejected update discards the transaction draft, so nothing is written.
 */
export function createCodexModelCatalogCommit(
  plugin: Pick<ProviderHost, 'mutateSettingsConditionally'>,
): CodexModelCatalogCommit {
  return async (update) => {
    let outcome: { selectionChanged: boolean } | null = null;
    await plugin.mutateSettingsConditionally(async (draft) => {
      const settings = draft as unknown as Record<string, unknown>;
      const config = getProviderConfig(settings, 'codex');
      const configChanged = await update(config);
      if (configChanged === null) return false;
      if (configChanged) setProviderConfig(settings, 'codex', config);
      const selectionChanged = ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
      outcome = { selectionChanged };
      return configChanged || selectionChanged;
    });
    return outcome;
  };
}

export async function createCodexWorkspaceServices(
  plugin: ProviderHost,
  options: CodexWorkspaceServicesOptions = {},
): Promise<CodexWorkspaceServices> {
  const runtimeHost = plugin.getRuntimeHost('codex');
  const runtime = new CodexAppServerRuntime(runtimeHost, message => { new Notice(message); });
  const skillListProvider = options.skillListingService
    ?? new CodexSkillListingService(runtime);
  const modelCatalogCoordinator = options.modelCatalogCoordinator
    ?? new CodexModelCatalogCoordinator(
      runtimeHost,
      new CodexModelDiscoveryService(runtimeHost, runtime),
      createCodexModelCatalogCommit(plugin),
    );
  const commandCatalog = new CodexCommandCatalog(skillListProvider);
  const modelCatalog = createCodexModels(runtimeHost, modelCatalogCoordinator);
  const sessionArchive = new CodexThreadArchiveService(runtime);
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('codex', {
      // Running sessions survive launch-only changes on the replacement server. A change that
      // invalidates Codex sessions retires their bindings, so the sessions end with them.
      preserveSessions: (_session, { sessionsInvalidated }) => (
        decodeCodexConfig(runtimeHost.config).enabled && !sessionsInvalidated
      ),
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

export function getCodexWorkspaceServices(): CodexWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('codex') as CodexWorkspaceServices;
}
