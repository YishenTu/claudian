import type { AgentInfo } from '@qoder-ai/qoder-agent-sdk';

import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderRuntimeCommandLoader,
  ProviderTabWarmupPolicy,
  ProviderTransitionOwnerContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { QoderAgentMentionProvider } from '../agents/QoderAgentMentionProvider';
import { QoderCommandCatalog } from '../commands/QoderCommandCatalog';
import { QoderCliResolver } from '../runtime/QoderCliResolver';
import { collectQoderRuntimeSnapshot } from '../runtime/QoderSdkBridge';
import { updateQoderProviderSettings } from '../settings';
import { qoderSettingsTabRenderer } from '../ui/QoderSettingsTab';
import { QoderRuntimeCommandLoader } from './QoderRuntimeCommandLoader';

export interface QoderWorkspaceSnapshot {
  agents: AgentInfo[];
  commands: SlashCommand[];
  skills: string[];
}

export interface QoderWorkspaceServices extends ProviderWorkspaceServices {
  agentMentionProvider: QoderAgentMentionProvider;
  cliResolver: QoderCliResolver;
  commandCatalog: ProviderCommandCatalog;
  refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): Promise<ProviderModelCatalogRefreshResult>;
  refreshRuntimeSnapshot(): Promise<void>;
  runtimeCommandLoader: ProviderRuntimeCommandLoader;
}

const qoderTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createQoderWorkspaceServices(
  plugin: ProviderHost,
): Promise<QoderWorkspaceServices> {
  const cliResolver = new QoderCliResolver();
  const agentMentionProvider = new QoderAgentMentionProvider();
  const snapshot: QoderWorkspaceSnapshot = {
    agents: [],
    commands: [],
    skills: [],
  };
  const commandCatalog = new QoderCommandCatalog(() => snapshot.skills);

  const refreshRuntimeSnapshot = async (): Promise<void> => {
    const next = await collectQoderRuntimeSnapshot({ cliResolver, plugin });
    snapshot.agents = next.agents;
    snapshot.commands = next.commands;
    snapshot.skills = next.skills;
    commandCatalog.setRuntimeCommands(next.commands);
    agentMentionProvider.setAgents(next.agents);
  };

  return {
    agentMentionProvider,
    cliResolver,
    commandCatalog,
    runtimeCommandLoader: new QoderRuntimeCommandLoader({
      getSnapshot: () => snapshot,
      refreshRuntimeSnapshot,
    }),
    settingsTabRenderer: qoderSettingsTabRenderer,
    tabWarmupPolicy: qoderTabWarmupPolicy,
    async refreshModelCatalog() {
      try {
        const next = await collectQoderRuntimeSnapshot({ cliResolver, plugin });
        snapshot.agents = next.agents;
        snapshot.commands = next.commands;
        snapshot.skills = next.skills;
        commandCatalog.setRuntimeCommands(next.commands);
        agentMentionProvider.setAgents(next.agents);
        await plugin.mutateSettings((settings) => {
          updateQoderProviderSettings(settings, {
            discoveredModels: next.models,
            visibleModels: next.models
              .filter(model => model.isDefault)
              .map(model => `qoder/${model.rawId}`),
          });
        });
        return { changed: true };
      } catch (error) {
        return {
          changed: false,
          diagnostics: error instanceof Error ? error.message : 'Could not refresh Qoder models.',
        };
      }
    },
    refreshRuntimeSnapshot,
  };
}

export const qoderWorkspaceRegistration: ProviderWorkspaceRegistration<QoderWorkspaceServices> = {
  initialize: async ({ plugin }) => createQoderWorkspaceServices(plugin),
};

export function getQoderWorkspaceServices(): QoderWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('qoder') as QoderWorkspaceServices;
}
