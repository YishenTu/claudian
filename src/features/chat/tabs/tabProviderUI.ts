import { getHiddenCommandSet } from '@/core/providers/commands/hiddenCommands';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { toggleServiceTier } from '@/features/chat/composer/toggleServiceTier';
import { getSessionProviderId } from '@/features/chat/sessions/sessionProvider';
import { getSessionCapabilities, getSessionChatUIConfig, getSessionSettingsSnapshot, updateSessionProviderSettings } from '@/features/chat/sessions/sessionSettings';
import { projectContextUsageDisplay } from '@/features/chat/state/usageInfo';
import type {
  AssembledTabRuntime,
  ProviderCatalogResolver,
} from '@/features/chat/tabs/types';

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

  const providerId = getSessionProviderId(tab, plugin, conversation);
  const catalogInfo = (getProviderCatalogConfig ?? tab.providerCatalogResolver)?.() ?? null;

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
  await updateSessionProviderSettings(tab.session.runtime, plugin, (settings) => {
    settings.serviceTier = serviceTier;
  });
  tab.ui.serviceTierToggle.updateDisplay();
}

export async function toggleTabServiceTier(
  tab: AssembledTabRuntime,
  plugin: ChatFeatureHost,
): Promise<boolean> {
  return await toggleServiceTier({
    getUIConfig: () => getSessionChatUIConfig(tab, plugin),
    getSettings: () => getSessionSettingsSnapshot(tab.session.runtime, plugin),
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
  const capabilities = getSessionCapabilities(tab, plugin);
  const uiConfig = getSessionChatUIConfig(tab, plugin);
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
  const settings = getSessionSettingsSnapshot(tab.session.runtime, plugin, conversation);
  tab.ui.contextUsageMeter.update(projectContextUsageDisplay(tab.state.usage, {
    providerId: getSessionProviderId(tab, plugin, conversation),
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
  const uiConfig = getSessionChatUIConfig(tab, plugin);
  try {
    await updateSessionProviderSettings(tab.session.runtime, plugin, (settings) => {
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
