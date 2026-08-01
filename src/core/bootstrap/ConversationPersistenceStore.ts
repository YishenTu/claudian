import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type { SessionMetadata } from '../types';
import {
  type ConversationInputLedger,
  type ConversationInputLedgerPersistence,
  type ConversationInputLedgerReadResult,
  ConversationInputLedgerStorage,
} from './ConversationInputLedgerStorage';
import {
  assertValidSessionMetadataId,
  type SessionMetadataReader,
  SessionStorage,
} from './SessionStorage';
import { DELETION_MARKER_SUFFIX, SESSIONS_PATH } from './storagePaths';

export const CONVERSATION_DELETION_MARKER_SCHEMA_VERSION = 1 as const;

export interface ConversationDeletionMarker {
  schemaVersion: typeof CONVERSATION_DELETION_MARKER_SCHEMA_VERSION;
  conversationId: string;
  deletedAt: number;
}

export interface ConversationPersistence {
  readonly metadataReader: SessionMetadataReader;
  loadInputLedger(
    conversationId: string,
  ): Promise<ConversationInputLedgerReadResult>;
  saveInputLedger(
    conversationId: string,
    ledger: ConversationInputLedger,
  ): Promise<void>;
  saveMetadata(metadata: SessionMetadata): Promise<void>;
  deleteCurrentMetadata(conversationId: string): Promise<void>;
  deleteLegacyMetadata(conversationId: string): Promise<void>;
  deleteInputLedger(conversationId: string): Promise<void>;
  isDeleted(conversationId: string): Promise<boolean>;
  markDeleted(conversationId: string, deletedAt: number): Promise<void>;
}

export class ConversationPersistenceStore implements ConversationPersistence {
  readonly metadataReader: SessionMetadataReader;

  private readonly metadataStorage: SessionStorage;
  private readonly inputLedgerStorage: ConversationInputLedgerPersistence;

  constructor(private readonly adapter: VaultFileAdapter) {
    this.metadataStorage = new SessionStorage(adapter);
    this.metadataReader = this.metadataStorage;
    this.inputLedgerStorage = new ConversationInputLedgerStorage(adapter);
  }

  loadInputLedger(
    conversationId: string,
  ): Promise<ConversationInputLedgerReadResult> {
    return this.inputLedgerStorage.load(conversationId);
  }

  saveInputLedger(
    conversationId: string,
    ledger: ConversationInputLedger,
  ): Promise<void> {
    return this.inputLedgerStorage.save(conversationId, ledger);
  }

  saveMetadata(metadata: SessionMetadata): Promise<void> {
    return this.adapter.write(
      this.metadataStorage.getMetadataPath(metadata.id),
      JSON.stringify(metadata, null, 2),
    );
  }

  deleteCurrentMetadata(conversationId: string): Promise<void> {
    return this.adapter.delete(
      this.metadataStorage.getMetadataPath(conversationId),
    );
  }

  deleteLegacyMetadata(conversationId: string): Promise<void> {
    return this.adapter.delete(
      this.metadataStorage.getLegacyMetadataPath(conversationId),
    );
  }

  deleteInputLedger(conversationId: string): Promise<void> {
    return this.inputLedgerStorage.delete(conversationId);
  }

  isDeleted(conversationId: string): Promise<boolean> {
    return this.adapter.exists(this.getDeletionMarkerPath(conversationId));
  }

  async markDeleted(conversationId: string, deletedAt: number): Promise<void> {
    const marker: ConversationDeletionMarker = {
      schemaVersion: CONVERSATION_DELETION_MARKER_SCHEMA_VERSION,
      conversationId,
      deletedAt,
    };
    await this.adapter.write(
      this.getDeletionMarkerPath(conversationId),
      JSON.stringify(marker, null, 2),
    );
  }

  private getDeletionMarkerPath(conversationId: string): string {
    assertValidSessionMetadataId(conversationId);
    return `${SESSIONS_PATH}/${conversationId}${DELETION_MARKER_SUFFIX}`;
  }
}
