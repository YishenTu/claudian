import { ProviderRegistry } from '../providers/ProviderRegistry';
import { DEFAULT_CHAT_PROVIDER_ID } from '../providers/types';
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

export class SessionStorage {
  constructor(private adapter: VaultFileAdapter) {}

  getMetadataPath(id: string): string {
    return `${SESSIONS_PATH}/${id}.meta.json`;
  }

  getLegacyMetadataPath(id: string): string {
    return `${LEGACY_SESSIONS_PATH}/${id}.meta.json`;
  }

  async saveMetadata(metadata: SessionMetadata): Promise<void> {
    const filePath = this.getMetadataPath(metadata.id);
    const content = JSON.stringify(metadata, null, 2);
    await this.adapter.write(filePath, content);
    await this.deleteLegacyMetadataIfPresent(metadata.id);
  }

  async loadMetadata(id: string): Promise<SessionMetadata | null> {
    const filePath = await this.getLoadPath(id);

    try {
      if (!filePath) {
        return null;
      }

      const content = await this.adapter.read(filePath);
      const metadata = JSON.parse(content) as SessionMetadata;

      if (filePath !== this.getMetadataPath(id)) {
        await this.saveMetadata(metadata);
      }

      return metadata;
    } catch {
      return null;
    }
  }

  async deleteMetadata(id: string): Promise<void> {
    await this.adapter.delete(this.getMetadataPath(id));
    await this.deleteLegacyMetadataIfPresent(id);
  }

  async listMetadata(): Promise<SessionMetadata[]> {
    const metas: SessionMetadata[] = [];

    const files = await this.listUniqueMetadataFiles();

    for (const filePath of files) {
      try {
        const content = await this.adapter.read(filePath);
        const raw = JSON.parse(content) as SessionMetadata;
        metas.push(raw);

        if (filePath.startsWith(`${LEGACY_SESSIONS_PATH}/`)) {
          await this.saveMetadata(raw);
        }
      } catch {
        // Skip files that fail to load.
      }
    }

    return metas;
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
    const providerState = ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .buildPersistedProviderState?.(conversation)
      ?? conversation.providerState;

    return {
      id: conversation.id,
      providerId: conversation.providerId,
      title: conversation.title,
      titleGenerationStatus: conversation.titleGenerationStatus,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      sessionId: conversation.sessionId,
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
}
