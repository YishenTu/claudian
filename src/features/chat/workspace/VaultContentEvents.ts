import type { EventRef, TAbstractFile, Vault } from 'obsidian';
import { Notice, TFolder } from 'obsidian';

import type { ChatViewHost } from '../ChatFeatureHost';

const VAULT_REFRESH_DELAY_MS = 50;

export interface VaultContentEventsDeps {
  readonly vault: Pick<Vault, 'on'>;
  readonly views: { getAllViews(): readonly ChatViewHost[] };
  readonly conversations: {
    /** Reconciles Linked content identity and pinned paths; publication stays with this owner. */
    applyVaultRename(oldPath: string, newPath: string, includeDescendants: boolean): Promise<void>;
    applyVaultDeletion(path: string, includeDescendants: boolean): Promise<void>;
  };
  notifyConversationListChanged(): void;
}

/**
 * Delivers Vault create, rename, and delete events to every chat view immediately, applies the
 * durable Linked content reconciliation, and coalesces the resulting list refreshes.
 */
export class VaultContentEvents {
  private refreshTimer: number | undefined;
  private disposed = false;

  constructor(private readonly deps: VaultContentEventsDeps) {}

  register(registerEvent: (eventRef: EventRef) => void): void {
    const { vault } = this.deps;
    registerEvent(vault.on('rename', (file, oldPath) => {
      void this.handleRename(file, oldPath).catch(() => {
        new Notice('Failed to update linked content paths');
      });
    }));
    registerEvent(vault.on('delete', (file) => {
      void this.handleDelete(file).catch(() => {
        new Notice('Failed to update pinned linked content');
      });
    }));
    registerEvent(vault.on('create', file => this.handleCreate(file)));
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    const includeDescendants = file instanceof TFolder;
    for (const view of this.deps.views.getAllViews()) {
      view.handleLinkedContentRenamed(oldPath, file.path, includeDescendants);
    }
    try {
      await this.deps.conversations.applyVaultRename(oldPath, file.path, includeDescendants);
    } finally {
      this.scheduleRefresh();
    }
  }

  async handleDelete(file: TAbstractFile): Promise<void> {
    const includeDescendants = file instanceof TFolder;
    for (const view of this.deps.views.getAllViews()) {
      view.handleLinkedContentDeleted(file.path, includeDescendants);
    }
    try {
      await this.deps.conversations.applyVaultDeletion(file.path, includeDescendants);
    } finally {
      this.scheduleRefresh();
    }
  }

  handleCreate(file: TAbstractFile): void {
    for (const view of this.deps.views.getAllViews()) {
      view.handleLinkedContentCreated(file.path);
    }
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer !== undefined) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.disposed) this.deps.notifyConversationListChanged();
    }, VAULT_REFRESH_DELAY_MS);
  }
}
