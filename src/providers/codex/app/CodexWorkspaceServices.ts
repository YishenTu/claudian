import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
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
import { CodexModelDiscoveryService } from '../runtime/CodexModelDiscoveryService';
import {
  getCodexProviderSettings,
  normalizeCodexVisibleModels,
  updateCodexProviderSettings,
} from '../settings';
import { CodexSkillListingService } from '../skills/CodexSkillListingService';
import { CodexSkillStorage } from '../storage/CodexSkillStorage';
import { CodexSubagentStorage } from '../storage/CodexSubagentStorage';
import { codexSettingsTabRenderer } from '../ui/CodexSettingsTab';

export interface CodexWorkspaceServices extends ProviderWorkspaceServices {
  subagentStorage: CodexSubagentStorage;
  commandCatalog: ProviderCommandCatalog;
  agentMentionProvider: CodexAgentMentionProvider;
  cliResolver: ProviderCliResolver;
}

function sameCatalog(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  await agentMentionProvider.loadAgents();

  const skillListProvider = new CodexSkillListingService(plugin);
  const modelDiscovery = new CodexModelDiscoveryService(plugin);
  const commandCatalog = new CodexSkillCatalog(
    new CodexSkillStorage(
      vaultAdapter,
      homeAdapter,
    ),
    skillListProvider,
    getVaultPath(plugin.app),
  );

  const services: CodexWorkspaceServices = {
    subagentStorage,
    commandCatalog,
    agentMentionProvider,
    cliResolver: createCodexCliResolver(),
    settingsTabRenderer: codexSettingsTabRenderer,
    refreshAgentMentions: async () => {
      await agentMentionProvider.loadAgents();
    },
    refreshModelCatalog: async () => {
      const result = await modelDiscovery.discoverModels();
      if (result.kind === 'skipped') {
        return { changed: false };
      }
      if (result.diagnostics) {
        return { changed: false, diagnostics: result.diagnostics };
      }
      if (result.models.length === 0) {
        return { changed: false, diagnostics: 'Codex app-server returned no visible models' };
      }

      let refreshResult = { changed: false, persistedSettingsChanged: false };
      await plugin.mutateSettingsConditionally((settings) => {
        const currentSettings = getCodexProviderSettings(settings);
        const currentModels = currentSettings.discoveredModels;
        const visibleModels = normalizeCodexVisibleModels(
          currentSettings.visibleModels,
          result.models,
        );
        const catalogChanged = !sameCatalog(currentModels, result.models);
        const visibilityChanged = !sameCatalog(currentSettings.visibleModels, visibleModels);
        if (catalogChanged || visibilityChanged) {
          updateCodexProviderSettings(settings, {
            discoveredModels: result.models,
            visibleModels,
          });
        }
        const selectionChanged = ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
        const persistedSettingsChanged = visibilityChanged || selectionChanged;
        refreshResult = {
          changed: catalogChanged || persistedSettingsChanged,
          persistedSettingsChanged,
        };
        return persistedSettingsChanged;
      });
      return refreshResult;
    },
  };

  if (getCodexProviderSettings(plugin.settings).enabled) {
    await services.refreshModelCatalog!();
  }

  return services;
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
