import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type { SessionMetadata } from '../types';
import {
  type SessionMetadataAuthority,
  type SessionMetadataReader,
  SessionStorage,
} from './SessionStorage';

export interface ConversationPersistence {
  readonly metadataReader: SessionMetadataReader;
  saveMetadata(
    metadata: SessionMetadata,
    target?: SessionMetadataAuthority,
  ): Promise<void>;
  deleteCurrentMetadata(
    conversationId: string,
    target?: SessionMetadataAuthority,
  ): Promise<void>;
  deleteLegacyMetadata(conversationId: string): Promise<void>;
  assignMetadataToDevice(conversationId: string): Promise<void>;
}

export class ConversationPersistenceStore implements ConversationPersistence {
  readonly metadataReader: SessionMetadataReader;
  private readonly metadataStorage: SessionStorage;

  constructor(
    private readonly adapter: VaultFileAdapter,
    deviceKey: string,
  ) {
    this.metadataStorage = new SessionStorage(adapter, deviceKey);
    this.metadataReader = this.metadataStorage;
  }

  async saveMetadata(
    metadata: SessionMetadata,
    target: SessionMetadataAuthority = 'device',
  ): Promise<void> {
    await this.adapter.write(
      this.getMetadataPath(metadata.id, target),
      JSON.stringify(metadata),
    );
  }

  deleteCurrentMetadata(
    conversationId: string,
    target: SessionMetadataAuthority = 'device',
  ): Promise<void> {
    return this.adapter.delete(this.getMetadataPath(conversationId, target));
  }

  deleteLegacyMetadata(conversationId: string): Promise<void> {
    return this.adapter.delete(this.metadataStorage.getLegacyMetadataPath(conversationId));
  }

  async assignMetadataToDevice(conversationId: string): Promise<void> {
    const source = this.metadataStorage.getUnscopedMetadataPath(conversationId);
    const target = this.metadataStorage.getMetadataPath(conversationId);
    if (await this.adapter.exists(target)) {
      throw new Error(`Cannot assign conversation ${conversationId}: device metadata already exists`);
    }
    if (!await this.adapter.exists(source)) {
      throw new Error(`Cannot assign conversation ${conversationId}: unscoped metadata is missing`);
    }
    await this.adapter.ensureFolder(target.slice(0, target.lastIndexOf('/')));
    await this.adapter.rename(source, target);
  }

  private getMetadataPath(
    conversationId: string,
    target: SessionMetadataAuthority,
  ): string {
    return target === 'device'
      ? this.metadataStorage.getMetadataPath(conversationId)
      : this.metadataStorage.getUnscopedMetadataPath(conversationId);
  }
}
