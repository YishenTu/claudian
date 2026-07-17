import { mapWithConcurrency } from '../../utils/concurrency';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { DEFAULT_CHAT_PROVIDER_ID, type SessionMetadataListOptions } from '../providers/types';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type {
  Conversation,
  ConversationMeta,
  SessionMetadata,
} from '../types';
import { LEGACY_SESSIONS_PATH, SESSIONS_PATH } from './StoragePaths';

export {
  LEGACY_SESSIONS_PATH,
  SESSIONS_PATH,
};

const SAFE_METADATA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_METADATA_READ_CONCURRENCY = 8;
const SESSION_METADATA_PUBLISH_BATCH_SIZE = 16;

export function isValidSessionMetadataId(id: string): boolean {
  return SAFE_METADATA_ID_PATTERN.test(id)
    && id !== '.'
    && id !== '..'
    && !/%(?:2f|5c)/i.test(id);
}

function assertValidSessionMetadataId(id: string): void {
  if (!isValidSessionMetadataId(id)) {
    throw new Error(`Invalid session metadata id: ${JSON.stringify(id)}`);
  }
}

export class SessionStorage {
  constructor(private adapter: VaultFileAdapter) {}

  getMetadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${SESSIONS_PATH}/${id}.meta.json`;
  }

  getLegacyMetadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${LEGACY_SESSIONS_PATH}/${id}.meta.json`;
  }

  async saveMetadata(metadata: SessionMetadata): Promise<void> {
    const filePath = this.getMetadataPath(metadata.id);
    const content = JSON.stringify(metadata, null, 2);
    await this.adapter.write(filePath, content);
    await this.deleteLegacyMetadataIfPresent(metadata.id);
  }

  async loadMetadata(id: string): Promise<SessionMetadata | null> {
    if (!isValidSessionMetadataId(id)) {
      return null;
    }
    let filePath: string | null;
    let metadata: SessionMetadata;
    try {
      filePath = await this.getLoadPath(id);
      if (!filePath) {
        return null;
      }

      const content = await this.adapter.read(filePath);
      metadata = JSON.parse(content) as SessionMetadata;
      if (metadata.id !== id || !isValidSessionMetadataId(metadata.id)) {
        return null;
      }
    } catch {
      return null;
    }

    if (filePath !== this.getMetadataPath(id)) {
      try {
        await this.saveMetadata(metadata);
      } catch {
        // Migration is best-effort; keep valid legacy metadata visible.
      }
    }

    return metadata;
  }

  async deleteMetadata(id: string): Promise<void> {
    await this.adapter.delete(this.getMetadataPath(id));
    await this.deleteLegacyMetadataIfPresent(id);
  }

  async listMetadata(options: SessionMetadataListOptions = {}): Promise<SessionMetadata[]> {
    const files = await this.listUniqueMetadataFiles();
    const pendingBatch: SessionMetadata[] = [];
    const batchSize = Math.max(1, options.batchSize ?? SESSION_METADATA_PUBLISH_BATCH_SIZE);
    const publish = (metadata: SessionMetadata): void => {
      if (!options.onBatch) return;
      pendingBatch.push(metadata);
      if (pendingBatch.length >= batchSize) {
        options.onBatch(pendingBatch.splice(0, pendingBatch.length));
      }
    };
    const metas = await mapWithConcurrency(files, async (filePath) => {
      const fileId = this.getMetadataIdFromPath(filePath);
      if (!fileId || !isValidSessionMetadataId(fileId)) {
        return null;
      }
      let raw: SessionMetadata;
      try {
        const content = await this.adapter.read(filePath);
        raw = JSON.parse(content) as SessionMetadata;
        if (raw.id !== fileId || !isValidSessionMetadataId(raw.id)) {
          return null;
        }
      } catch {
        // Skip files that fail to load.
        return null;
      }

      if (filePath.startsWith(`${LEGACY_SESSIONS_PATH}/`)) {
        try {
          await this.saveMetadata(raw);
        } catch {
          // Migration is best-effort; keep valid legacy metadata visible.
        }
      }
      publish(raw);
      return raw;
    }, SESSION_METADATA_READ_CONCURRENCY);

    if (pendingBatch.length > 0) {
      options.onBatch?.(pendingBatch.splice(0, pendingBatch.length));
    }

    return metas.filter((meta): meta is SessionMetadata => meta !== null);
  }

  async listAllConversations(): Promise<ConversationMeta[]> {
    const nativeMetas = await this.listMetadata();

    const metas: ConversationMeta[] = nativeMetas.map((meta) => ({
      id: meta.id,
      providerId: meta.providerId ?? DEFAULT_CHAT_PROVIDER_ID,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastResponseAt: meta.lastResponseAt,
      messageCount: 0,
      preview: 'SDK session',
      titleGenerationStatus: meta.titleGenerationStatus,
    }));

    return metas.sort((a, b) =>
      (b.lastResponseAt ?? b.createdAt) - (a.lastResponseAt ?? a.createdAt)
    );
  }

  toSessionMetadata(conversation: Conversation): SessionMetadata {
    const historyService = ProviderRegistry.getConversationHistoryService(conversation.providerId);
    const providerState = historyService.buildPersistedProviderState
      ? historyService.buildPersistedProviderState(conversation)
      : conversation.providerState;

    return {
      id: conversation.id,
      providerId: conversation.providerId,
      title: conversation.title,
      titleGenerationStatus: conversation.titleGenerationStatus,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      sessionId: conversation.sessionId,
      selectedModel: conversation.selectedModel,
      providerState: providerState && Object.keys(providerState).length > 0 ? providerState : undefined,
      currentNote: conversation.currentNote,
      externalContextPaths: conversation.externalContextPaths,
      enabledMcpServers: conversation.enabledMcpServers,
      usage: conversation.usage,
      resumeAtMessageId: conversation.resumeAtMessageId,
    };
  }

  private async getLoadPath(id: string): Promise<string | null> {
    const filePath = this.getMetadataPath(id);
    if (await this.adapter.exists(filePath)) {
      return filePath;
    }

    const legacyFilePath = this.getLegacyMetadataPath(id);
    if (await this.adapter.exists(legacyFilePath)) {
      return legacyFilePath;
    }

    return null;
  }

  private async deleteLegacyMetadataIfPresent(id: string): Promise<void> {
    const legacyFilePath = this.getLegacyMetadataPath(id);
    if (await this.adapter.exists(legacyFilePath)) {
      await this.adapter.delete(legacyFilePath);
    }
  }

  private async listUniqueMetadataFiles(): Promise<string[]> {
    const preferredFiles = await this.listMetadataFiles(SESSIONS_PATH);
    const fallbackFiles = await this.listMetadataFiles(LEGACY_SESSIONS_PATH);
    const filesByName = new Map<string, string>();

    for (const filePath of preferredFiles) {
      filesByName.set(this.getFileName(filePath), filePath);
    }

    for (const filePath of fallbackFiles) {
      const fileName = this.getFileName(filePath);
      if (!filesByName.has(fileName)) {
        filesByName.set(fileName, filePath);
      }
    }

    return Array.from(filesByName.values());
  }

  private async listMetadataFiles(folderPath: string): Promise<string[]> {
    try {
      const files = await this.adapter.listFiles(folderPath);
      return files.filter((filePath) => filePath.endsWith('.meta.json'));
    } catch {
      return [];
    }
  }

  private getFileName(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1] ?? filePath;
  }

  private getMetadataIdFromPath(filePath: string): string | null {
    const fileName = this.getFileName(filePath);
    const suffix = '.meta.json';
    return fileName.endsWith(suffix)
      ? fileName.slice(0, -suffix.length)
      : null;
  }
}
