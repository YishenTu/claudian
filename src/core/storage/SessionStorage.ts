/**
 * SessionStorage - Handles chat session files in vault/.claude/sessions/
 *
 * Each conversation is stored as a JSONL (JSON Lines) file.
 * First line contains metadata, subsequent lines contain messages.
 *
 * JSONL format:
 * ```
 * {"type":"meta","id":"conv-123","title":"Fix bug","createdAt":1703500000,"sessionId":"sdk-xyz"}
 * {"type":"message","id":"msg-1","role":"user","content":"...","timestamp":1703500001}
 * {"type":"message","id":"msg-2","role":"assistant","content":"...","timestamp":1703500002}
 * ```
 */

import type {
  ChatMessage,
  Conversation,
  ConversationMeta,
  SessionMetadata,
  UsageInfo,
} from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to sessions folder relative to vault root. */
export const SESSIONS_PATH = '.claude/sessions';

/** Metadata record stored as first line of JSONL. */
interface SessionMetaRecord {
  type: 'meta';
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastResponseAt?: number;
  sessionId: string | null;
  currentNote?: string;
  usage?: UsageInfo;
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
}

/** Message record stored as subsequent lines. */
interface SessionMessageRecord {
  type: 'message';
  message: ChatMessage;
}

/** Union type for JSONL records. */
type SessionRecord = SessionMetaRecord | SessionMessageRecord;

export class SessionStorage {
  constructor(private adapter: VaultFileAdapter) { }

  /** Load a conversation from its JSONL file. */
  async loadConversation(id: string): Promise<Conversation | null> {
    const filePath = this.getFilePath(id);

    try {
      if (!(await this.adapter.exists(filePath))) {
        return null;
      }

      const content = await this.adapter.read(filePath);
      return this.parseJSONL(content);
    } catch {
      return null;
    }
  }

  /** Save a conversation to its JSONL file. */
  async saveConversation(conversation: Conversation): Promise<void> {
    const filePath = this.getFilePath(conversation.id);
    const content = this.serializeToJSONL(conversation);
    await this.adapter.write(filePath, content);
  }

  /** Delete a conversation's JSONL file. */
  async deleteConversation(id: string): Promise<void> {
    const filePath = this.getFilePath(id);
    await this.adapter.delete(filePath);
  }

  /** List all conversation metadata (without loading full messages). */
  async listConversations(): Promise<ConversationMeta[]> {
    const metas: ConversationMeta[] = [];

    try {
      const files = await this.adapter.listFiles(SESSIONS_PATH);

      for (const filePath of files) {
        if (!filePath.endsWith('.jsonl')) continue;

        try {
          const meta = await this.loadMetaOnly(filePath);
          if (meta) {
            metas.push(meta);
          }
        } catch {
          // Skip files that fail to load
        }
      }

      // Sort by updatedAt descending (most recent first)
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      // Return empty list if directory listing fails
    }

    return metas;
  }

  /** Load all conversations (full data). Returns conversations and count of failed loads. */
  async loadAllConversations(): Promise<{ conversations: Conversation[]; failedCount: number }> {
    const conversations: Conversation[] = [];
    let failedCount = 0;

    try {
      const files = await this.adapter.listFiles(SESSIONS_PATH);

      for (const filePath of files) {
        if (!filePath.endsWith('.jsonl')) continue;

        try {
          const content = await this.adapter.read(filePath);
          const conversation = this.parseJSONL(content);
          if (conversation) {
            conversations.push(conversation);
          } else {
            failedCount++;
          }
        } catch {
          failedCount++;
        }
      }

      // Sort by updatedAt descending
      conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      // Return empty list if directory listing fails
    }

    return { conversations, failedCount };
  }

  /** Check if any sessions exist. */
  async hasSessions(): Promise<boolean> {
    const files = await this.adapter.listFiles(SESSIONS_PATH);
    return files.some(f => f.endsWith('.jsonl'));
  }

  /** Get the file path for a conversation. */
  getFilePath(id: string): string {
    return `${SESSIONS_PATH}/${id}.jsonl`;
  }

  /** Load only metadata from a session file (first line). */
  private async loadMetaOnly(filePath: string): Promise<ConversationMeta | null> {
    const content = await this.adapter.read(filePath);
    // Handle both Unix (LF) and Windows (CRLF) line endings
    const firstLine = content.split(/\r?\n/)[0];

    if (!firstLine) return null;

    try {
      const record = JSON.parse(firstLine) as SessionRecord;
      if (record.type !== 'meta') return null;

      // Count messages by counting remaining lines
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      const messageCount = lines.length - 1;

      // Get preview from first user message
      let preview = 'New conversation';
      for (let i = 1; i < lines.length; i++) {
        try {
          const msgRecord = JSON.parse(lines[i]) as SessionRecord;
          if (msgRecord.type === 'message' && msgRecord.message.role === 'user') {
            const content = msgRecord.message.content;
            preview = content.substring(0, 50) + (content.length > 50 ? '...' : '');
            break;
          }
        } catch {
          continue;
        }
      }

      return {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastResponseAt: record.lastResponseAt,
        messageCount,
        preview,
        titleGenerationStatus: record.titleGenerationStatus,
      };
    } catch {
      return null;
    }
  }

  /** Parse JSONL content into a Conversation object. */
  private parseJSONL(content: string): Conversation | null {
    // Handle both Unix (LF) and Windows (CRLF) line endings
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) return null;

    let meta: SessionMetaRecord | null = null;
    const messages: ChatMessage[] = [];

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as SessionRecord;

        if (record.type === 'meta') {
          meta = record;
        } else if (record.type === 'message') {
          messages.push(record.message);
        }
      } catch {
        // Skip invalid JSONL lines
      }
    }

    if (!meta) return null;

    return {
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastResponseAt: meta.lastResponseAt,
      sessionId: meta.sessionId,
      messages,
      currentNote: meta.currentNote,
      usage: meta.usage,
      titleGenerationStatus: meta.titleGenerationStatus,
    };
  }

  /** Serialize a Conversation to JSONL format. */
  private serializeToJSONL(conversation: Conversation): string {
    const lines: string[] = [];

    // First line: metadata
    const meta: SessionMetaRecord = {
      type: 'meta',
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      sessionId: conversation.sessionId,
      currentNote: conversation.currentNote,
      usage: conversation.usage,
      titleGenerationStatus: conversation.titleGenerationStatus,
    };
    lines.push(JSON.stringify(meta));

    // Subsequent lines: messages
    for (const message of conversation.messages) {
      const storedMessage = this.prepareMessageForStorage(message);
      const record: SessionMessageRecord = {
        type: 'message',
        message: storedMessage,
      };
      lines.push(JSON.stringify(record));
    }

    return lines.join('\n');
  }

  /** Prepare a message for storage. */
  private prepareMessageForStorage(message: ChatMessage): ChatMessage {
    // Images are stored with their base64 data as single source of truth
    return message;
  }

  // ============================================
  // SDK-Native Session Metadata (Phase 1)
  // ============================================

  /**
   * Detects if a session uses SDK-native storage.
   * A session is "native" if no legacy JSONL file exists.
   *
   * Legacy sessions have id.jsonl (and optionally id.meta.json).
   * Native sessions have only id.meta.json or no files yet (SDK stores messages).
   */
  async isNativeSession(id: string): Promise<boolean> {
    const legacyPath = `${SESSIONS_PATH}/${id}.jsonl`;
    const legacyExists = await this.adapter.exists(legacyPath);
    // Native if no legacy JSONL exists (new conversation or meta-only)
    return !legacyExists;
  }

  /** Get the metadata file path for a session. */
  getMetadataPath(id: string): string {
    return `${SESSIONS_PATH}/${id}.meta.json`;
  }

  /** Save session metadata overlay for SDK-native storage. */
  async saveMetadata(metadata: SessionMetadata): Promise<void> {
    const filePath = this.getMetadataPath(metadata.id);
    const content = JSON.stringify(metadata, null, 2);
    await this.adapter.write(filePath, content);
  }

  /** Load session metadata for SDK-native storage. */
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

  /** Delete session metadata. */
  async deleteMetadata(id: string): Promise<void> {
    const filePath = this.getMetadataPath(id);
    await this.adapter.delete(filePath);
  }

  /** List all native session metadata (.meta.json files without .jsonl counterparts). */
  async listNativeMetadata(): Promise<SessionMetadata[]> {
    const metas: SessionMetadata[] = [];

    try {
      const files = await this.adapter.listFiles(SESSIONS_PATH);

      // Find .meta.json files
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));

      for (const filePath of metaFiles) {
        // Extract ID from path: .claude/sessions/{id}.meta.json
        const fileName = filePath.split('/').pop() || '';
        const id = fileName.replace('.meta.json', '');

        // Check if this is truly native (no legacy .jsonl exists)
        const legacyPath = `${SESSIONS_PATH}/${id}.jsonl`;
        const legacyExists = await this.adapter.exists(legacyPath);

        if (legacyExists) {
          // Skip - this has legacy storage, meta.json is supplementary
          continue;
        }

        try {
          const content = await this.adapter.read(filePath);
          const meta = JSON.parse(content) as SessionMetadata;
          metas.push(meta);
        } catch {
          // Skip files that fail to load
        }
      }
    } catch {
      // Return empty list if directory listing fails
    }

    return metas;
  }

  /**
   * List all conversations, merging legacy JSONL and native metadata sources.
   * Legacy conversations take precedence if both exist.
   */
  async listAllConversations(): Promise<ConversationMeta[]> {
    const metas: ConversationMeta[] = [];

    // 1. Load legacy conversations (existing .jsonl files)
    const legacyMetas = await this.listConversations();
    metas.push(...legacyMetas);

    // 2. Load native metadata (.meta.json files)
    const nativeMetas = await this.listNativeMetadata();

    // 3. Merge, avoiding duplicates (legacy takes precedence)
    const legacyIds = new Set(legacyMetas.map(m => m.id));
    for (const meta of nativeMetas) {
      if (!legacyIds.has(meta.id)) {
        metas.push({
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          lastResponseAt: meta.lastResponseAt,
          messageCount: 0, // Native sessions don't track message count in metadata
          preview: 'SDK session', // SDK stores messages, we don't parse them for preview
          titleGenerationStatus: meta.titleGenerationStatus,
          isNative: true,
        });
      }
    }

    // 4. Sort by lastResponseAt descending (fallback to createdAt)
    return metas.sort((a, b) =>
      (b.lastResponseAt ?? b.createdAt) - (a.lastResponseAt ?? a.createdAt)
    );
  }

  /** Convert a Conversation to SessionMetadata for native storage. */
  toSessionMetadata(conversation: Conversation): SessionMetadata {
    return {
      id: conversation.id,
      title: conversation.title,
      titleGenerationStatus: conversation.titleGenerationStatus,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      sessionId: conversation.sessionId,
      sdkSessionId: conversation.sdkSessionId,
      currentNote: conversation.currentNote,
      externalContextPaths: conversation.externalContextPaths,
      enabledMcpServers: conversation.enabledMcpServers,
      usage: conversation.usage,
      legacyCutoffAt: conversation.legacyCutoffAt,
    };
  }
}
