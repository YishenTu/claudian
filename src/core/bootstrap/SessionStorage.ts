import { ProviderRegistry } from '../providers/ProviderRegistry';
import { DEFAULT_CHAT_PROVIDER_ID } from '../providers/types';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type {
  Conversation,
  ConversationMeta,
  SessionMetadata,
} from '../types';

/** Path to sessions folder relative to vault root. */
export const SESSIONS_PATH = '.claude/sessions';

export class SessionStorage {
  constructor(private adapter: VaultFileAdapter) {}

  getMetadataPath(id: string): string {
    return `${SESSIONS_PATH}/${id}.meta.json`;
  }

  async saveMetadata(metadata: SessionMetadata): Promise<void> {
    const filePath = this.getMetadataPath(metadata.id);
    const content = JSON.stringify(metadata, null, 2);
    await this.adapter.write(filePath, content);
  }

  async loadMetadata(id: string): Promise<SessionMetadata | null> {
    const filePath = this.getMetadataPath(id);

    try {
      if (!(await this.adapter.exists(filePath))) {
        return null;
      }

      const content = await this.adapter.read(filePath);
      return JSON.parse(content) as SessionMetadata;
    } catch {
      return null;
    }
  }

  async deleteMetadata(id: string): Promise<void> {
    const filePath = this.getMetadataPath(id);
    await this.adapter.delete(filePath);
  }

  async listMetadata(): Promise<SessionMetadata[]> {
    const metas: SessionMetadata[] = [];

    try {
      const files = await this.adapter.listFiles(SESSIONS_PATH);
      const metaFiles = files.filter((filePath) => filePath.endsWith('.meta.json'));

      for (const filePath of metaFiles) {
        try {
          const content = await this.adapter.read(filePath);
          const raw = JSON.parse(content) as SessionMetadata;
          metas.push(raw);
        } catch {
          // Skip files that fail to load.
        }
      }
    } catch {
      // Return empty list if directory listing fails.
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
}
