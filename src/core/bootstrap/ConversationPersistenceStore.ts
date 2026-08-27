import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type { SessionMetadata } from '../types';
import {
  type ConversationInputLedger,
  type ConversationInputLedgerPersistence,
  type ConversationInputLedgerReadResult,
  ConversationInputLedgerStorage,
} from './ConversationInputLedgerStorage';
import {
  SESSION_METADATA_ASSIGNMENT_SCHEMA_VERSION,
  type SessionMetadataAssignment,
  type SessionMetadataAuthority,
  type SessionMetadataReader,
  SessionStorage,
} from './SessionStorage';

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
    target?: SessionMetadataAuthority,
  ): Promise<void>;
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
  deleteInputLedger(conversationId: string): Promise<void>;
  isDeleted(
    conversationId: string,
    target?: SessionMetadataAuthority,
  ): Promise<boolean>;
  assertMetadataWriteAuthority(
    conversationId: string,
    target: SessionMetadataAuthority,
  ): Promise<void>;
  markDeleted(
    conversationId: string,
    deletedAt: number,
    target?: SessionMetadataAuthority,
  ): Promise<void>;
}

class SessionMetadataOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionMetadataOwnershipError';
  }
}

export class ConversationPersistenceStore implements ConversationPersistence {
  readonly metadataReader: SessionMetadataReader;

  private readonly metadataStorage: SessionStorage;
  private readonly inputLedgerStorage: ConversationInputLedgerPersistence;

  constructor(
    private readonly adapter: VaultFileAdapter,
    deviceKey: string,
  ) {
    this.metadataStorage = new SessionStorage(adapter, deviceKey);
    this.metadataReader = this.metadataStorage;
    this.inputLedgerStorage = new ConversationInputLedgerStorage(adapter);
  }

  loadInputLedger(
    conversationId: string,
  ): Promise<ConversationInputLedgerReadResult> {
    return this.inputLedgerStorage.load(conversationId);
  }

  async saveInputLedger(
    conversationId: string,
    ledger: ConversationInputLedger,
    target: SessionMetadataAuthority = 'device',
  ): Promise<void> {
    await this.assertMetadataWriteAuthority(conversationId, target);
    await this.inputLedgerStorage.save(conversationId, ledger);
  }

  async saveMetadata(
    metadata: SessionMetadata,
    target: SessionMetadataAuthority = 'device',
  ): Promise<void> {
    await this.assertMetadataWriteAuthority(metadata.id, target);
    await this.adapter.write(
      this.getMetadataPath(metadata.id, target),
      JSON.stringify(metadata, null, 2),
    );
  }

  deleteCurrentMetadata(
    conversationId: string,
    target: SessionMetadataAuthority = 'device',
  ): Promise<void> {
    return this.adapter.delete(
      this.getMetadataPath(conversationId, target),
    );
  }

  deleteLegacyMetadata(conversationId: string): Promise<void> {
    return this.adapter.delete(
      this.metadataStorage.getLegacyMetadataPath(conversationId),
    );
  }

  async assignMetadataToDevice(conversationId: string): Promise<void> {
    await this.assertMetadataWriteAuthority(conversationId, 'unscoped');
    const source = this.metadataStorage.getUnscopedMetadataPath(conversationId);
    const target = this.metadataStorage.getMetadataPath(conversationId);
    if (await this.adapter.exists(target)) {
      throw new Error(`Cannot assign conversation ${conversationId}: device metadata already exists`);
    }
    if (!await this.adapter.exists(source)) {
      throw new Error(
        `Cannot assign conversation ${conversationId}: unscoped metadata is missing`,
      );
    }

    const targetFolder = target.slice(0, target.lastIndexOf('/'));
    await this.adapter.ensureFolder(targetFolder);
    const assignmentPath = this.metadataStorage.getAssignmentMarkerPath(conversationId);
    const assignment: SessionMetadataAssignment = {
      schemaVersion: SESSION_METADATA_ASSIGNMENT_SCHEMA_VERSION,
      conversationId,
      deviceKey: this.metadataStorage.getDeviceKey(),
    };
    await this.adapter.write(
      assignmentPath,
      JSON.stringify(assignment, null, 2),
    );
    try {
      await this.adapter.rename(source, target);
    } catch (error) {
      try {
        await this.adapter.delete(assignmentPath);
      } catch (rollbackError) {
        throw new Error(
          `Cannot assign conversation ${conversationId}: metadata move failed (${String(error)}) and assignment-fence rollback failed`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }

  deleteInputLedger(conversationId: string): Promise<void> {
    return this.inputLedgerStorage.delete(conversationId);
  }

  isDeleted(
    conversationId: string,
    target: SessionMetadataAuthority = 'device',
  ): Promise<boolean> {
    return this.adapter.exists(this.getDeletionMarkerPath(conversationId, target));
  }

  async markDeleted(
    conversationId: string,
    deletedAt: number,
    target: SessionMetadataAuthority = 'device',
  ): Promise<void> {
    await this.assertMetadataWriteAuthority(conversationId, target);
    const marker: ConversationDeletionMarker = {
      schemaVersion: CONVERSATION_DELETION_MARKER_SCHEMA_VERSION,
      conversationId,
      deletedAt,
    };
    await this.adapter.write(
      this.getDeletionMarkerPath(conversationId, target),
      JSON.stringify(marker, null, 2),
    );
  }

  private getDeletionMarkerPath(
    conversationId: string,
    target: SessionMetadataAuthority,
  ): string {
    return target === 'device'
      ? this.metadataStorage.getDeviceDeletionMarkerPath(conversationId)
      : this.metadataStorage.getUnscopedDeletionMarkerPath(conversationId);
  }

  private getMetadataPath(
    conversationId: string,
    target: SessionMetadataAuthority,
  ): string {
    switch (target) {
      case 'device':
        return this.metadataStorage.getMetadataPath(conversationId);
      case 'unscoped':
        return this.metadataStorage.getUnscopedMetadataPath(conversationId);
    }
  }

  async assertMetadataWriteAuthority(
    conversationId: string,
    target: SessionMetadataAuthority,
  ): Promise<void> {
    const assignment = await this.metadataStorage.loadAssignment(conversationId);
    if (assignment.status === 'missing') return;
    if (assignment.status === 'invalid') {
      throw new SessionMetadataOwnershipError(
        `Cannot write conversation ${conversationId}: assignment fence is invalid`,
      );
    }

    const assignedToCurrentDevice = assignment.assignment.deviceKey
      === this.metadataStorage.getDeviceKey();
    if (target === 'device' && assignedToCurrentDevice) return;
    throw new SessionMetadataOwnershipError(
      `Cannot write conversation ${conversationId}: assigned to ${
        assignedToCurrentDevice ? 'the current device' : 'another device'
      }`,
    );
  }
}
