import { Notice, type Plugin } from 'obsidian';

import type { SharedAppStorage } from '@/core/bootstrap/storage';
import { getInstallationKey, type InstallationKey } from '@/core/device/InstallationKey';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { ClaudianSettings } from '@/core/types';

import { ClaudianSettingsStorage, type StoredClaudianSettings } from '../settings/ClaudianSettingsStorage';
import { ConversationPersistenceStore } from './ConversationPersistenceStore';
import { migrateSessionSidecars } from './migrateSessionSidecars';
import { SessionStorage } from './SessionStorage';

export class SharedStorageService implements SharedAppStorage {
  readonly installationKey: InstallationKey;
  readonly claudianSettings: ClaudianSettingsStorage;
  readonly sessions: SessionStorage;
  readonly conversationPersistence: ConversationPersistenceStore;

  private adapter: VaultFileAdapter;
  private obsoleteSessionInputs: string[] = [];

  constructor(plugin: Plugin, defaultSettings: Readonly<ClaudianSettings>) {
    this.adapter = new VaultFileAdapter(plugin.app);
    const deviceKey = this.installationKey = getInstallationKey();
    this.claudianSettings = new ClaudianSettingsStorage(this.adapter, defaultSettings);
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

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }
}
