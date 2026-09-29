import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
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
import type { ClaudeDiscoveredModel } from '../modelCatalog';
import { ClaudeCLIResolver } from '../runtime/ClaudeCLIResolver';
import {
  applySessionClaudeModels,
  type ClaudeModelProbe,
  createClaudeModels,
  discoverClaudeModels,
} from '../runtime/ClaudeModels';
import { createClaudeSettingsTabRenderer } from '../ui/ClaudeSettingsTab';

export interface ClaudeWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: ProviderCLIResolver;
  commandCatalog: ProviderCommandCatalog;
  /** Writes back the model list a live session reported at init. */
  publishSessionModels(models: ClaudeDiscoveredModel[]): Promise<void>;
  dispose(): Promise<void>;
}

export interface ClaudeWorkspaceServicesOptions {
  readonly commandProbe?: CommandProbe;
  readonly modelProbe?: ClaudeModelProbe;
}

export async function createClaudeWorkspaceServices(
  plugin: ProviderHost,
  options: ClaudeWorkspaceServicesOptions = {},
): Promise<ClaudeWorkspaceServices> {
  const cliResolver = new ClaudeCLIResolver();
  const modelCatalog = createClaudeModels(plugin, signal => discoverClaudeModels(plugin, signal, options.modelProbe));

  const commandCatalog = new ClaudeCommandCatalog(
    options.commandProbe ?? (signal => probeRuntimeCommands(plugin, signal)),
  );
  let transitioning = false;
  let disposed = false;
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('claude', {
      beforeTransition: async () => {
        transitioning = true;
        modelCatalog.beginTransition();
        await modelCatalog.quiesce();
        await commandCatalog.beginEnvironmentTransition();
      },
      afterTransition: () => {
        commandCatalog.endEnvironmentTransition();
        modelCatalog.endTransition();
        transitioning = false;
      },
    });
  let disposePromise: Promise<void> | null = null;

  return {
    cliResolver,
    commandCatalog,
    settingsTabRenderer: createClaudeSettingsTabRenderer({ cliResolver, modelCatalog }),
    modelCatalog,
    async publishSessionModels(models) {
      // A session reporting across an environment transition may describe the old runtime.
      await applySessionClaudeModels(plugin, models, () => !disposed && !transitioning);
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      unregisterTransitionHook();
      disposePromise = Promise.all([commandCatalog.dispose(), modelCatalog.dispose()]).then(() => undefined);
      return disposePromise;
    },
  };
}

export const claudeWorkspaceRegistration: ProviderWorkspaceRegistration<ClaudeWorkspaceServices> = {
  initialize: async ({ plugin }) => createClaudeWorkspaceServices(plugin),
};

export function getClaudeWorkspaceServices(): ClaudeWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getIfInitialized('claude') as ClaudeWorkspaceServices | null;
}
