import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderVaultEntryRepository } from '../../../core/providers/commands/ProviderVaultEntryRepository';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCliResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { AgentManager } from '../agents/AgentManager';
import {
  ClaudeCommandCatalog,
  type CommandProbe,
} from '../commands/ClaudeCommandCatalog';
import { probeRuntimeCommands } from '../commands/probeRuntimeCommands';
import { resolveClaudeConfigDir } from '../config/ClaudeConfigDir';
import { ClaudePluginDiscovery } from '../plugins/ClaudePluginDiscovery';
import { ClaudeCliResolver } from '../runtime/ClaudeCliResolver';
import { AgentVaultStorage } from '../storage/AgentVaultStorage';
import { SkillStorage } from '../storage/SkillStorage';
import { SlashCommandStorage } from '../storage/SlashCommandStorage';
import { claudeSettingsTabRenderer } from '../ui/ClaudeSettingsTab';

export interface ClaudeWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: ProviderCliResolver;
  agentStorage: AgentVaultStorage;
  agentManager: AgentManager;
  commandCatalog: ProviderCommandCatalog;
  vaultCommandRepository: ProviderVaultEntryRepository;
  dispose(): Promise<void>;
}

export interface ClaudeWorkspaceServicesOptions {
  readonly commandProbe?: CommandProbe;
}

export async function createClaudeWorkspaceServices(
  plugin: ProviderHost,
  adapter: VaultFileAdapter,
  options: ClaudeWorkspaceServicesOptions = {},
): Promise<ClaudeWorkspaceServices> {
  const cliResolver = new ClaudeCliResolver();

  const vaultPath = getVaultPath(plugin.app) ?? '';
  const getClaudeConfigDir = () => resolveClaudeConfigDir({
    environment: {
      ...process.env,
      ...parseEnvironmentVariables(plugin.getActiveEnvironmentVariables('claude')),
    },
    hostPlatform: process.platform,
    vaultPath,
  });
  const pluginDiscovery = new ClaudePluginDiscovery(
    vaultPath,
    getClaudeConfigDir,
  );

  const agentStorage = new AgentVaultStorage(adapter);
  const agentManager = new AgentManager(vaultPath, pluginDiscovery, getClaudeConfigDir);

  const commandCatalog = new ClaudeCommandCatalog(
    new SlashCommandStorage(adapter),
    new SkillStorage(adapter),
    options.commandProbe ?? (signal => probeRuntimeCommands(plugin, signal)),
  );
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('claude', {
      beforeTransition: () => commandCatalog.beginEnvironmentTransition(),
      afterTransition: () => commandCatalog.endEnvironmentTransition(),
    });
  let disposePromise: Promise<void> | null = null;

  return {
    cliResolver,
    agentStorage,
    agentManager,
    commandCatalog,
    vaultCommandRepository: commandCatalog,
    settingsTabRenderer: claudeSettingsTabRenderer,
    prepareSettings: async () => {
      await pluginDiscovery.loadPlugins();
      await agentManager.loadAgents();
    },
    dispose() {
      if (disposePromise) return disposePromise;
      unregisterTransitionHook();
      disposePromise = commandCatalog.dispose();
      return disposePromise;
    },
  };
}

export const claudeWorkspaceRegistration: ProviderWorkspaceRegistration<ClaudeWorkspaceServices> = {
  initialize: async ({ plugin, vaultAdapter }) => createClaudeWorkspaceServices(plugin, vaultAdapter),
};

export function getClaudeWorkspaceServices(): ClaudeWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('claude') as ClaudeWorkspaceServices;
}
