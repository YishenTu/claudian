import { Notice, type Plugin } from 'obsidian';

import { ConversationPersistenceStore } from '../../core/bootstrap/ConversationPersistenceStore';
import { migrateSessionSidecars } from '../../core/bootstrap/migrateSessionSidecars';
import { SessionStorage } from '../../core/bootstrap/SessionStorage';
import type { SharedAppStorage } from '../../core/bootstrap/storage';
import { normalizeTabManagerState } from '../../core/bootstrap/tabManagerState';
import type { AppTabManagerState } from '../../core/providers/types';
import { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import { getHostnameKey } from '../../utils/env';
import { ClaudianSettingsStorage, type StoredClaudianSettings } from '../settings/ClaudianSettingsStorage';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class SharedStorageService implements SharedAppStorage {
  readonly claudianSettings: ClaudianSettingsStorage;
  readonly sessions: SessionStorage;
  readonly conversationPersistence: ConversationPersistenceStore;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;
  private obsoleteSessionInputs: string[] = [];

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.adapter = new VaultFileAdapter(plugin.app);
    const deviceKey = getHostnameKey();
    this.claudianSettings = new ClaudianSettingsStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter, deviceKey);
    this.conversationPersistence = new ConversationPersistenceStore(this.adapter, deviceKey);
  }

  async initialize(): Promise<{ claudian: Record<string, unknown> }> {
    // Settings and session recovery touch separate files. Join both even if settings fail.
    const [settings] = await Promise.allSettled([
      this.claudianSettings.load(),
      migrateSessionSidecars(this.adapter).then(paths => {
        this.obsoleteSessionInputs = paths;
      }).catch(() => {
        new Notice('Failed to clean up obsolete session files; will retry next launch');
      }),
    ]);
    if (settings.status === 'rejected') throw settings.reason;
    return { claudian: settings.value };
  }

  async cleanupObsoleteSessionInputs(signal: AbortSignal): Promise<void> {
    try {
      for (const file of this.obsoleteSessionInputs) {
        if (signal.aborted) return;
        await this.adapter.delete(file);
      }
      this.obsoleteSessionInputs = [];
    } catch {
      new Notice('Failed to clean up obsolete session files; will retry next launch');
    }
  }

  async saveClaudianSettings(settings: Record<string, unknown>): Promise<void> {
    await this.claudianSettings.save(settings as StoredClaudianSettings);
  }

  async getTabManagerState(): Promise<AppTabManagerState | null> {
    try {
      const data: unknown = await this.plugin.loadData();
      if (!isRecord(data) || !data.tabManagerState) {
        return null;
      }

      return normalizeTabManagerState(data.tabManagerState);
    } catch {
      return null;
    }
  }

  async clearTabManagerState(): Promise<void> {
    const loaded: unknown = await this.plugin.loadData();
    if (!isRecord(loaded) || !('tabManagerState' in loaded)) return;

    const data = { ...loaded };
    delete data.tabManagerState;
    await this.plugin.saveData(data);
  }

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }
}
