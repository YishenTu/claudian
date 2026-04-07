import type { Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import { SESSIONS_PATH, SessionStorage } from '../../core/bootstrap/SessionStorage';
import type { SharedAppStorage } from '../../core/bootstrap/storage';
import { CLAUDIAN_STORAGE_PATH } from '../../core/bootstrap/StoragePaths';
import { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import type { SkillRun } from '../../core/types';
import { SKILLS_PATH, SkillStorage } from '../../providers/claude/storage/SkillStorage';
import { ClaudianSettingsStorage, type StoredClaudianSettings } from '../settings/ClaudianSettingsStorage';

export class SharedStorageService implements SharedAppStorage {
  readonly claudianSettings: ClaudianSettingsStorage;
  readonly sessions: SessionStorage;
  readonly skills: SkillStorage;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.adapter = new VaultFileAdapter(plugin.app);
    this.claudianSettings = new ClaudianSettingsStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
    this.skills = new SkillStorage(this.adapter);
  }

  async initialize(): Promise<{ claudian: Record<string, unknown> }> {
    await this.ensureDirectories();
    const claudian = await this.claudianSettings.load();
    return { claudian };
  }

  async saveClaudianSettings(settings: Record<string, unknown>): Promise<void> {
    await this.claudianSettings.save(settings as StoredClaudianSettings);
  }

  async setTabManagerState(state: { openTabs: Array<{ tabId: string; conversationId: string | null }>; activeTabId: string | null }): Promise<void> {
    try {
      const data = (await this.plugin.loadData()) || {};
      data.tabManagerState = state;
      await this.plugin.saveData(data);
    } catch {
      new Notice('Failed to save tab layout');
    }
  }

  async getTabManagerState(): Promise<{ openTabs: Array<{ tabId: string; conversationId: string | null }>; activeTabId: string | null } | null> {
    try {
      const data = await this.plugin.loadData();
      if (!data?.tabManagerState) {
        return null;
      }

      return this.validateTabManagerState(data.tabManagerState);
    } catch {
      return null;
    }
  }

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }

  async getSkillRuns(): Promise<SkillRun[]> {
    try {
      const data = await this.plugin.loadData();
      if (!Array.isArray(data?.skillRuns)) {
        return [];
      }

      return data.skillRuns as SkillRun[];
    } catch {
      return [];
    }
  }

  async getSkillRunUsageCounts(): Promise<Record<string, number>> {
    try {
      const data = await this.plugin.loadData();
      if (!data?.skillRunUsageCounts || typeof data.skillRunUsageCounts !== 'object') {
        return {};
      }

      const counts: Record<string, number> = {};
      for (const [key, value] of Object.entries(data.skillRunUsageCounts as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          counts[key] = Math.floor(value);
        }
      }
      return counts;
    } catch {
      return {};
    }
  }

  async setSkillRunState(runs: SkillRun[], usageCounts: Record<string, number>): Promise<void> {
    try {
      const data = (await this.plugin.loadData()) || {};
      data.skillRuns = runs;
      data.skillRunUsageCounts = usageCounts;
      await this.plugin.saveData(data);
    } catch {
      new Notice('Failed to save skill runs');
    }
  }

  private async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(CLAUDIAN_STORAGE_PATH);
    await this.adapter.ensureFolder(SESSIONS_PATH);
    await this.adapter.ensureFolder(SKILLS_PATH);
  }

  private validateTabManagerState(data: unknown): { openTabs: Array<{ tabId: string; conversationId: string | null }>; activeTabId: string | null } | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const state = data as Record<string, unknown>;
    if (!Array.isArray(state.openTabs)) {
      return null;
    }

    const validatedTabs: Array<{ tabId: string; conversationId: string | null }> = [];
    for (const tab of state.openTabs) {
      if (!tab || typeof tab !== 'object') {
        continue;
      }

      const tabObj = tab as Record<string, unknown>;
      if (typeof tabObj.tabId !== 'string') {
        continue;
      }

      validatedTabs.push({
        tabId: tabObj.tabId,
        conversationId: typeof tabObj.conversationId === 'string' ? tabObj.conversationId : null,
      });
    }

    return {
      openTabs: validatedTabs,
      activeTabId: typeof state.activeTabId === 'string' ? state.activeTabId : null,
    };
  }
}
