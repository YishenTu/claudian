import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ProviderCLIResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import {
  ClaudeCommandCatalog,
  type CommandProbe,
} from '../commands/ClaudeCommandCatalog';
import { probeRuntimeCommands } from '../commands/probeRuntimeCommands';
import { ClaudeCLIResolver } from '../runtime/ClaudeCLIResolver';
import { ClaudeModelCatalog } from '../runtime/ClaudeModelCatalog';
import { createClaudeModels } from '../runtime/ClaudeModels';
import { createClaudeSettingsTabRenderer } from '../ui/ClaudeSettingsTab';

export interface ClaudeWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: ProviderCLIResolver;
  commandCatalog: ProviderCommandCatalog;
  dispose(): Promise<void>;
}

export interface ClaudeWorkspaceServicesOptions {
  readonly commandProbe?: CommandProbe;
  readonly modelProbe?: ConstructorParameters<typeof ClaudeModelCatalog>[1];
}

export async function createClaudeWorkspaceServices(
  plugin: ProviderHost,
  options: ClaudeWorkspaceServicesOptions = {},
): Promise<ClaudeWorkspaceServices> {
  const cliResolver = new ClaudeCLIResolver();
  const nativeCatalog = new ClaudeModelCatalog(plugin, options.modelProbe);
  const modelCatalog = createClaudeModels(plugin, nativeCatalog);

  const commandCatalog = new ClaudeCommandCatalog(
    options.commandProbe ?? (signal => probeRuntimeCommands(plugin, signal)),
  );
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('claude', {
      beforeTransition: async () => {
        modelCatalog.beginTransition();
        await nativeCatalog.cancel();
        await commandCatalog.beginEnvironmentTransition();
      },
      afterTransition: () => { commandCatalog.endEnvironmentTransition(); modelCatalog.endTransition(); },
    });
  let disposePromise: Promise<void> | null = null;

  return {
    cliResolver,
    commandCatalog,
    settingsTabRenderer: createClaudeSettingsTabRenderer({ cliResolver, modelCatalog }),
    modelCatalog,
    dispose() {
      if (disposePromise) return disposePromise;
      unregisterTransitionHook();
      disposePromise = Promise.all([commandCatalog.dispose(), modelCatalog.dispose(), nativeCatalog.dispose()]).then(() => undefined);
      return disposePromise;
    },
  };
}

export const claudeWorkspaceRegistration: ProviderWorkspaceRegistration<ClaudeWorkspaceServices> = {
  initialize: async ({ plugin }) => createClaudeWorkspaceServices(plugin),
};
