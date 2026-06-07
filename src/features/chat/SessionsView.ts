import type { WorkspaceLeaf } from 'obsidian';
import { ItemView } from 'obsidian';

import { VIEW_TYPE_CLAUDIAN_SESSIONS } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { SessionsPanel } from './ui/SessionsPanel';

/**
 * Companion right-sidebar view that hosts the session switcher panel.
 *
 * Thin shell: lifecycle only. It mounts a `SessionsPanel` (which drives the
 * active main-window chat view's TabManager) and subscribes to the plugin's
 * sessions-change emitter so the panel re-renders as tabs and conversations change.
 */
export class SessionsView extends ItemView {
  private plugin: ClaudianPlugin;
  private panel: SessionsPanel | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudianPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDIAN_SESSIONS;
  }

  getDisplayText(): string {
    return 'Claudian sessions';
  }

  getIcon(): string {
    // Match the main chat view's icon so the sidebar tab reads as Claudian.
    return 'bot';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('claudian-sessions-view');

    this.panel = new SessionsPanel(this.plugin, container);
    this.panel.render();

    this.unsubscribe = this.plugin.onSessionsChanged(() => this.panel?.render());
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;

    this.panel?.destroy();
    this.panel = null;
  }
}
