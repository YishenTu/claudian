/**
 * Claudian - Plugin Settings Manager
 *
 * Component for managing Claude Code plugins in the settings tab.
 * Displays plugin list with status indicators and toggle buttons.
 */

import { Notice, setIcon } from 'obsidian';

import type { ClaudianPlugin as ClaudianPluginType, PluginScope } from '../../../core/types';
import type ClaudianPlugin from '../../../main';

/** Component for managing Claude Code plugins in settings tab. */
export class PluginSettingsManager {
  private containerEl: HTMLElement;
  private plugin: ClaudianPlugin;

  constructor(containerEl: HTMLElement, plugin: ClaudianPlugin) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.render();
  }

  private render() {
    this.containerEl.empty();

    // Header with refresh button
    const headerEl = this.containerEl.createDiv({ cls: 'claudian-plugin-header' });
    headerEl.createSpan({ text: 'Claude Code Plugins', cls: 'claudian-plugin-label' });

    const refreshBtn = headerEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Refresh' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.refreshPlugins());

    const plugins = this.plugin.pluginManager.getPlugins();

    // Empty state
    if (plugins.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-plugin-empty' });
      emptyEl.setText('No Claude Code plugins installed. Install plugins via the Claude CLI.');
      return;
    }

    // Group plugins by scope
    const projectLocalPlugins = plugins.filter(p => p.scope === 'project' || p.scope === 'local');
    const userPlugins = plugins.filter(p => p.scope === 'user');

    const listEl = this.containerEl.createDiv({ cls: 'claudian-plugin-list' });

    // Project/Local plugins section
    if (projectLocalPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'claudian-plugin-section-header' });
      sectionHeader.setText('Project Plugins');

      for (const plugin of projectLocalPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }

    // User plugins section
    if (userPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'claudian-plugin-section-header' });
      sectionHeader.setText('User Plugins');

      for (const plugin of userPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }
  }

  private renderPluginItem(listEl: HTMLElement, plugin: ClaudianPluginType) {
    const itemEl = listEl.createDiv({ cls: 'claudian-plugin-item' });
    if (!plugin.enabled) {
      itemEl.addClass('claudian-plugin-item-disabled');
    }
    if (plugin.status !== 'available') {
      itemEl.addClass('claudian-plugin-item-error');
    }

    // Status indicator (colored dot)
    const statusEl = itemEl.createDiv({ cls: 'claudian-plugin-status' });
    if (plugin.status !== 'available') {
      statusEl.addClass('claudian-plugin-status-error');
    } else if (plugin.enabled) {
      statusEl.addClass('claudian-plugin-status-enabled');
    } else {
      statusEl.addClass('claudian-plugin-status-disabled');
    }

    // Info section
    const infoEl = itemEl.createDiv({ cls: 'claudian-plugin-info' });

    // Name row with badges
    const nameRow = infoEl.createDiv({ cls: 'claudian-plugin-name-row' });

    const nameEl = nameRow.createSpan({ cls: 'claudian-plugin-name' });
    nameEl.setText(plugin.name);

    // Scope badge
    const scopeEl = nameRow.createSpan({ cls: 'claudian-plugin-scope-badge' });
    scopeEl.setText(this.getScopeLabel(plugin.scope));

    // Error badge if unavailable
    if (plugin.status !== 'available') {
      const errorEl = nameRow.createSpan({ cls: 'claudian-plugin-error-badge' });
      errorEl.setText(plugin.status === 'unavailable' ? 'Unavailable' : 'Invalid');
    }

    // Description or error message
    const previewEl = infoEl.createDiv({ cls: 'claudian-plugin-preview' });
    if (plugin.error) {
      previewEl.setText(plugin.error);
      previewEl.addClass('claudian-plugin-preview-error');
    } else if (plugin.description) {
      previewEl.setText(plugin.description);
    } else {
      previewEl.setText(plugin.id);
    }

    // Actions
    const actionsEl = itemEl.createDiv({ cls: 'claudian-plugin-actions' });

    // Enable/disable toggle button (only if available)
    if (plugin.status === 'available') {
      const toggleBtn = actionsEl.createEl('button', {
        cls: 'claudian-plugin-action-btn',
        attr: { 'aria-label': plugin.enabled ? 'Disable' : 'Enable' },
      });
      setIcon(toggleBtn, plugin.enabled ? 'toggle-right' : 'toggle-left');
      toggleBtn.addEventListener('click', () => this.togglePlugin(plugin.id));
    }
  }

  private getScopeLabel(scope: PluginScope): string {
    switch (scope) {
      case 'user':
        return 'User';
      case 'project':
        return 'Project';
      case 'local':
        return 'Local';
    }
  }

  private async togglePlugin(pluginId: string) {
    const plugin = this.plugin.pluginManager.getPlugins().find(p => p.id === pluginId);
    const wasEnabled = plugin?.enabled ?? false;

    try {
      // Toggle plugin (writes to .claude/settings.json)
      await this.plugin.pluginManager.togglePlugin(pluginId);

      // Reload plugin slash commands
      this.plugin.loadPluginSlashCommands();
      await this.plugin.agentManager.loadAgents();

      // Restart persistent query to apply plugin changes to all tabs
      const view = this.plugin.getView();
      const tabManager = view?.getTabManager();
      if (tabManager) {
        try {
          await tabManager.broadcastToAllTabs(
            async (service) => { await service.ensureReady({ force: true }); }
          );
        } catch {
          new Notice('Plugin toggled, but some tabs failed to restart.');
        }
      }

      if (plugin) {
        new Notice(`Plugin "${plugin.name}" ${wasEnabled ? 'disabled' : 'enabled'}`);
      }
    } catch (err) {
      // Revert the toggle on failure
      await this.plugin.pluginManager.togglePlugin(pluginId);
      const message = err instanceof Error ? err.message : 'Unknown error';
      new Notice(`Failed to toggle plugin: ${message}`);
    } finally {
      this.render();
    }
  }

  private async refreshPlugins() {
    try {
      await this.plugin.pluginManager.loadPlugins();

      // Reload plugin slash commands to pick up new/updated/removed plugins
      this.plugin.loadPluginSlashCommands();
      await this.plugin.agentManager.loadAgents();

      // Restart persistent query to apply plugin tool changes to all tabs
      const view = this.plugin.getView();
      const tabManager = view?.getTabManager();
      if (tabManager) {
        try {
          await tabManager.broadcastToAllTabs(
            async (service) => { await service.ensureReady({ force: true }); }
          );
        } catch {
          new Notice('Plugins refreshed, but some tabs failed to restart.');
          return;
        }
      }

      new Notice('Plugin list refreshed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      new Notice(`Failed to refresh plugins: ${message}`);
    } finally {
      this.render();
    }
  }

  /** Refresh the plugin list (call after external changes). */
  public refresh() {
    this.render();
  }
}
