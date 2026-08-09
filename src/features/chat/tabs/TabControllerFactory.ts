import type { Component } from 'obsidian';

import type { ChatRewindMode } from '../../../core/execution';
import type { ProviderCapabilities } from '../../../core/providers/types';
import type { FeatureHost } from '../../FeatureHost';
import { BrowserSelectionController } from '../controllers/BrowserSelectionController';
import { CanvasSelectionController } from '../controllers/CanvasSelectionController';
import { SelectionController } from '../controllers/SelectionController';
import { MessageRenderer } from '../rendering/MessageRenderer';
import type { TabData, TabManagerViewHost } from './types';

export interface TabPresentationControllerOptions {
  plugin: FeatureHost;
  component: Component;
  getCapabilities: () => ProviderCapabilities;
  onRewind: (messageId: string, mode?: ChatRewindMode) => Promise<void>;
  onForkRequest?: (messageId: string) => Promise<void>;
  onCommitProvisional: () => void;
}

/**
 * Installs the renderer and selection controllers that form the tab's
 * presentation layer. Execution controllers are intentionally initialized by
 * the tab orchestration flow after this layer exists.
 */
export function initializeTabPresentationControllers(
  tab: TabData,
  options: TabPresentationControllerOptions,
): void {
  const { dom, ui } = tab;
  const viewHost = options.component as Partial<TabManagerViewHost>;
  const focusScopeEls = viewHost.getSharedSelectionFocusScopeEls?.() ?? [];

  tab.renderer = new MessageRenderer(
    options.plugin,
    options.component,
    dom.messagesEl,
    options.onRewind,
    options.onForkRequest
      ? options.onForkRequest
      : undefined,
    options.getCapabilities,
  );

  tab.controllers.selectionController = new SelectionController(
    options.plugin.app,
    ui.contextTray!,
    dom.inputEl,
    undefined,
    [dom.contentEl, dom.inputComposerEl, ...focusScopeEls],
    options.onCommitProvisional,
  );

  tab.controllers.browserSelectionController = new BrowserSelectionController(
    options.plugin.app,
    ui.contextTray!,
    dom.inputEl,
    undefined,
    options.onCommitProvisional,
  );

  tab.controllers.canvasSelectionController = new CanvasSelectionController(
    options.plugin.app,
    ui.contextTray!,
    dom.inputEl,
    undefined,
    options.onCommitProvisional,
  );
}
