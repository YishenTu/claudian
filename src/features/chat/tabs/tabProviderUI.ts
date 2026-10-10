import { createCatalogCommandDiscoveryStore } from '@/core/providers/commands/catalogCommandDiscovery';
import { getHiddenCommandSet } from '@/core/providers/commands/hiddenCommands';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { toggleServiceTier } from '@/features/chat/composer/toggleServiceTier';
import { projectContextUsageDisplay } from '@/features/chat/state/usageInfo';
import { getTabProviderId } from '@/features/chat/tabs/providerResolution';
import { getTabCapabilities, getTabChatUIConfig, getTabSettingsSnapshot, updateTabProviderSettings } from '@/features/chat/tabs/tabProviderSettings';
import type {
  AssembledTabRuntime,
  ProviderCatalogInfo,
  ProviderCatalogResolver,
} from '@/features/chat/tabs/types';

function getRegistryProviderCatalogInfo(providerId: ProviderId): ProviderCatalogInfo {
  const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
  if (!catalog) {
    return null;
  }

  return {
    config: catalog.getDropdownConfig(),
    discovery: createCatalogCommandDiscoveryStore(catalog, { includeBuiltIns: true }),
  };
}

export function syncComposerDropdownForProvider(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  getProviderCatalogConfig?: ProviderCatalogResolver,
  conversation?: Conversation | null,
): void {
  const dropdown = tab.ui.composerDropdown;
  if (!dropdown) {
    return;
  }

  const providerId = getTabProviderId(tab, plugin, conversation);
  const catalogInfo = (getProviderCatalogConfig ?? tab.providerCatalogResolver)?.()
    ?? (providerId ? getRegistryProviderCatalogInfo(providerId) : null);

  dropdown.setProviderId(providerId);

  if (catalogInfo) {
    dropdown.setProviderCatalog?.(catalogInfo.config, catalogInfo.discovery);
  } else {
    dropdown.clearProviderCatalog?.();
  }

  dropdown.setHiddenCommands(getHiddenCommandSet(plugin.settings));
}

export function invalidateTabProviderCommands(
  tab: AssembledTabRuntime,
  getProviderCatalogConfig?: ProviderCatalogResolver,
): void {
  const catalogInfo = (getProviderCatalogConfig ?? tab.providerCatalogResolver)?.() ?? null;
  catalogInfo?.discovery.invalidate();
}

export async function updateTabServiceTier(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  serviceTier: string,
): Promise<void> {
  await updateTabProviderSettings(tab, plugin, (settings) => {
    settings.serviceTier = serviceTier;
  });
  tab.ui.serviceTierToggle.updateDisplay();
}

export async function toggleTabServiceTier(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
): Promise<boolean> {
  return await toggleServiceTier({
    getUIConfig: () => getTabChatUIConfig(tab, plugin),
    getSettings: () => getTabSettingsSnapshot(tab, plugin),
    onServiceTierChange: serviceTier => updateTabServiceTier(tab, plugin, serviceTier),
  });
}

export function refreshTabProviderUI(tab: AssembledTabRuntime): void {
  tab.ui.modelSelector.updateDisplay();
  tab.ui.modelSelector.renderOptions();
  tab.ui.modeSelector.updateDisplay();
  tab.ui.modeSelector.renderOptions();
  tab.ui.effortSelector.updateDisplay();
  tab.ui.permissionToggle.updateDisplay();
  tab.ui.serviceTierToggle.updateDisplay();
}

export function applyProviderUIGating(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
): void {
  const capabilities = getTabCapabilities(tab, plugin);
  const uiConfig = getTabChatUIConfig(tab, plugin);
  const hasPermissionToggle = Boolean(uiConfig.getPermissionModeOptions?.()?.length);

  tab.ui.permissionToggle.setVisible(hasPermissionToggle);

  tab.ui.imageContextManager.setEnabled(capabilities.supportsImageAttachments);
  refreshTabContextUsage(tab, plugin);
}

/** Renders the tab's raw usage through the shared reported-window/custom-limit projection. */
export function refreshTabContextUsage(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
): void {
  const conversation = tab.conversationId ? plugin.getConversationSummary(tab.conversationId) : null;
  const settings = getTabSettingsSnapshot(tab, plugin, conversation);
  tab.ui.contextUsageMeter.update(projectContextUsageDisplay(tab.state.usage, {
    providerId: getTabProviderId(tab, plugin, conversation),
    model: settings.model,
    customContextLimits: settings.customContextLimits,
  }));
}

export function refreshTabWorkspaceServices(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
): void {
  syncComposerDropdownForProvider(tab, plugin);
  applyProviderUIGating(tab, plugin);
}


export async function updateTabPermissionMode(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
  mode: string,
): Promise<void> {
  const uiConfig = getTabChatUIConfig(tab, plugin);
  try {
    await updateTabProviderSettings(tab, plugin, (settings) => {
      if (uiConfig.applyPermissionMode) {
        uiConfig.applyPermissionMode(mode, settings);
      } else {
        settings.permissionMode = mode;
      }
    });
  } finally {
    tab.ui.permissionToggle.updateDisplay();
  }
}
