import { Notice, setIcon } from 'obsidian';

import type { GeminianPlugin as GeminianPluginType } from '../../../core/types';
import type GeminianPlugin from '../../../main';

export class PluginSettingsManager {
  private containerEl: HTMLElement;
  private plugin: GeminianPlugin;

  constructor(containerEl: HTMLElement, plugin: GeminianPlugin) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.render();
  }

  private render() {
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'geminian-plugin-header' });
    headerEl.createSpan({ text: 'Gemini CLI Plugins', cls: 'geminian-plugin-label' });

    const refreshBtn = headerEl.createEl('button', {
      cls: 'geminian-settings-action-btn',
      attr: { 'aria-label': 'Refresh' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.refreshPlugins());

    const plugins = this.plugin.pluginManager.getPlugins();

    if (plugins.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'geminian-plugin-empty' });
      emptyEl.setText('No Gemini CLI plugins found. Enable plugins via the Gemini CLI.');
      return;
    }

    const projectPlugins = plugins.filter(p => p.scope === 'project');
    const userPlugins = plugins.filter(p => p.scope === 'user');

    const listEl = this.containerEl.createDiv({ cls: 'geminian-plugin-list' });

    if (projectPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'geminian-plugin-section-header' });
      sectionHeader.setText('Project Plugins');

      for (const plugin of projectPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }

    if (userPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'geminian-plugin-section-header' });
      sectionHeader.setText('User Plugins');

      for (const plugin of userPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }
  }

  private renderPluginItem(listEl: HTMLElement, plugin: GeminianPluginType) {
    const itemEl = listEl.createDiv({ cls: 'geminian-plugin-item' });
    if (!plugin.enabled) {
      itemEl.addClass('geminian-plugin-item-disabled');
    }

    const statusEl = itemEl.createDiv({ cls: 'geminian-plugin-status' });
    if (plugin.enabled) {
      statusEl.addClass('geminian-plugin-status-enabled');
    } else {
      statusEl.addClass('geminian-plugin-status-disabled');
    }

    const infoEl = itemEl.createDiv({ cls: 'geminian-plugin-info' });

    const nameRow = infoEl.createDiv({ cls: 'geminian-plugin-name-row' });

    const nameEl = nameRow.createSpan({ cls: 'geminian-plugin-name' });
    nameEl.setText(plugin.name);

    const actionsEl = itemEl.createDiv({ cls: 'geminian-plugin-actions' });

    const toggleBtn = actionsEl.createEl('button', {
      cls: 'geminian-plugin-action-btn',
      attr: { 'aria-label': plugin.enabled ? 'Disable' : 'Enable' },
    });
    setIcon(toggleBtn, plugin.enabled ? 'toggle-right' : 'toggle-left');
    toggleBtn.addEventListener('click', () => this.togglePlugin(plugin.id));
  }

  private async togglePlugin(pluginId: string) {
    const plugin = this.plugin.pluginManager.getPlugins().find(p => p.id === pluginId);
    const wasEnabled = plugin?.enabled ?? false;

    try {
      await this.plugin.pluginManager.togglePlugin(pluginId);
      await this.plugin.agentManager.loadAgents();

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

      new Notice(`Plugin "${pluginId}" ${wasEnabled ? 'disabled' : 'enabled'}`);
    } catch (err) {
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
      await this.plugin.agentManager.loadAgents();

      new Notice('Plugin list refreshed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      new Notice(`Failed to refresh plugins: ${message}`);
    } finally {
      this.render();
    }
  }

  public refresh() {
    this.render();
  }
}
