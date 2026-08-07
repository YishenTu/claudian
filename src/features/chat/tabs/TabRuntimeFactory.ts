import type { Component } from 'obsidian';

import type { ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import type { TabAttention } from '@/features/chat/state/types';
import type { FeatureHost } from '@/features/FeatureHost';

import {
  createTab,
  destroyTab,
  type ForkContext,
  initializeTabControllers,
  initializeTabUI,
  wireTabInputEvents,
} from './Tab';
import type {
  ProviderCatalogInfo,
  ReadyTabData,
  TabData,
  TabId,
  TabProviderContext,
} from './types';

export interface TabRuntimeFactoryOptions {
  plugin: FeatureHost;
  containerEl: HTMLElement;
  component: Component;
  conversation?: Conversation;
  tabId?: TabId;
  draftModel?: string | null;
  lifecycleState?: Extract<TabData['lifecycleState'], 'provisional' | 'cold'>;
  getProviderCatalogConfig: (
    tab: TabProviderContext & Pick<TabData, 'id'>,
  ) => ProviderCatalogInfo;
  forkRequestCallback?: (forkContext: ForkContext) => Promise<void>;
  openConversation?: (conversationId: string) => Promise<void>;
  onStreamingChanged?: (tab: ReadyTabData, isStreaming: boolean) => void;
  onRewindingChanged?: (tab: ReadyTabData, isRewinding: boolean) => void;
  onAttentionChanged?: (tab: ReadyTabData, attention: TabAttention) => void;
  onConversationIdChanged?: (tab: ReadyTabData, conversationId: string | null) => void;
  onProviderChanged?: (tab: ReadyTabData, providerId: ProviderId) => void | Promise<void>;
  onCommandContextChanged?: (tab: ReadyTabData) => void;
  captureReviewableSettlement?: (tab: ReadyTabData) => () => void;
}

function assertReadyTabRuntime(tab: TabData): asserts tab is ReadyTabData {
  const requiredParts: Array<[name: string, value: unknown]> = [
    ['executionCoordinator', tab.executionCoordinator],
    ['providerCatalogResolver', tab.providerCatalogResolver],
    ['renderer', tab.renderer],
    ['controllers.selectionController', tab.controllers.selectionController],
    ['controllers.browserSelectionController', tab.controllers.browserSelectionController],
    ['controllers.canvasSelectionController', tab.controllers.canvasSelectionController],
    ['controllers.conversationController', tab.controllers.conversationController],
    ['controllers.streamController', tab.controllers.streamController],
    ['controllers.inputController', tab.controllers.inputController],
    ['controllers.navigationController', tab.controllers.navigationController],
    ['services.titleGenerationService', tab.services.titleGenerationService],
    ['ui.contextTray', tab.ui.contextTray],
    ['ui.fileContextManager', tab.ui.fileContextManager],
    ['ui.imageContextManager', tab.ui.imageContextManager],
    ['ui.modelSelector', tab.ui.modelSelector],
    ['ui.modeSelector', tab.ui.modeSelector],
    ['ui.thinkingBudgetSelector', tab.ui.thinkingBudgetSelector],
    ['ui.externalContextSelector', tab.ui.externalContextSelector],
    ['ui.mcpServerSelector', tab.ui.mcpServerSelector],
    ['ui.permissionToggle', tab.ui.permissionToggle],
    ['ui.serviceTierToggle', tab.ui.serviceTierToggle],
    ['ui.slashCommandDropdown', tab.ui.slashCommandDropdown],
    ['ui.instructionModeManager', tab.ui.instructionModeManager],
    ['ui.contextUsageMeter', tab.ui.contextUsageMeter],
    ['ui.statusPanel', tab.ui.statusPanel],
  ];
  const missingParts = requiredParts
    .filter(([, value]) => value === null || value === undefined)
    .map(([name]) => name);

  if (missingParts.length > 0) {
    throw new Error(`Tab runtime assembly incomplete: ${missingParts.join(', ')}`);
  }
}

async function rollbackTabRuntime(tab: TabData): Promise<void> {
  try {
    await destroyTab(tab);
  } catch {
    try {
      tab.dom.contentEl.remove();
    } catch {
      // Preserve the construction failure that triggered rollback.
    }
  }
}

/** Creates a structurally complete tab runtime or rolls back all partial ownership. */
export async function createTabRuntime(
  options: TabRuntimeFactoryOptions,
): Promise<ReadyTabData> {
  let tab: TabData | null = null;
  let readyTab: ReadyTabData | null = null;
  const requireReadyTab = (): ReadyTabData => {
    if (!readyTab) {
      throw new Error('Tab runtime callback invoked before assembly completed');
    }
    return readyTab;
  };

  try {
    tab = createTab({
      plugin: options.plugin,
      containerEl: options.containerEl,
      conversation: options.conversation,
      tabId: options.tabId,
      draftModel: options.draftModel,
      lifecycleState: options.lifecycleState,
      captureReviewableSettlement: options.captureReviewableSettlement
        ? () => options.captureReviewableSettlement!(requireReadyTab())
        : undefined,
    });
    const constructingTab = tab;

    initializeTabUI(constructingTab, options.plugin, {
      getProviderCatalogConfig: () => options.getProviderCatalogConfig(constructingTab),
      onCommandContextChanged: options.onCommandContextChanged
        ? () => options.onCommandContextChanged!(requireReadyTab())
        : undefined,
      onProviderChanged: options.onProviderChanged
        ? providerId => options.onProviderChanged!(requireReadyTab(), providerId)
        : undefined,
    });
    initializeTabControllers(
      constructingTab,
      options.plugin,
      options.component,
      options.forkRequestCallback,
      options.openConversation,
      () => options.getProviderCatalogConfig(constructingTab),
    );
    wireTabInputEvents(constructingTab, options.plugin);
    assertReadyTabRuntime(constructingTab);
    readyTab = constructingTab;

    constructingTab.state.callbacks = {
      ...constructingTab.state.callbacks,
      onStreamingStateChanged: options.onStreamingChanged
        ? isStreaming => options.onStreamingChanged!(requireReadyTab(), isStreaming)
        : undefined,
      onRewindingStateChanged: options.onRewindingChanged
        ? isRewinding => options.onRewindingChanged!(requireReadyTab(), isRewinding)
        : undefined,
      onAttentionChanged: options.onAttentionChanged
        ? attention => options.onAttentionChanged!(requireReadyTab(), attention)
        : undefined,
      onConversationChanged: options.onConversationIdChanged
        ? conversationId => options.onConversationIdChanged!(requireReadyTab(), conversationId)
        : undefined,
    };

    return constructingTab;
  } catch (error) {
    if (tab) {
      await rollbackTabRuntime(tab);
    }
    throw error;
  }
}
