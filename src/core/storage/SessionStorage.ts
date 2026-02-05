/**
 * SessionStorage - Handles chat session files in vault/.claude/sessions/
 * and SDK native sessions in ~/.claude/projects/
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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  ChatMessage,
  Conversation,
  ConversationMeta,
  SessionMetadata,
  SubagentInfo,
  UsageInfo,
} from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to sessions folder relative to vault root. */
export const SESSIONS_PATH = '.claude/sessions';

/** Path to SDK projects directory. */
const SDK_PROJECTS_PATH = path.join(os.homedir(), '.claude', 'projects');

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
  private vaultPath: string;
  private useCCWorkingDirectory: boolean;

  constructor(
    private adapter: VaultFileAdapter,
    options?: { vaultPath?: string; useCCWorkingDirectory?: boolean }
  ) {
    this.vaultPath = options?.vaultPath || '';
    this.useCCWorkingDirectory = options?.useCCWorkingDirectory ?? true;
  }

  /**
   * Get the SDK project directory to use for sessions.
   * Returns the encoded vault path or home directory based on settings.
   */
  private getSDKProjectDir(): string {
    if (this.useCCWorkingDirectory) {
      // Use home directory (same as CC CLI)
      return path.join(SDK_PROJECTS_PATH, path.resolve(os.homedir()).replace(/[^a-zA-Z0-9]/g, '-'));
    }
    // Use vault path
    return path.join(SDK_PROJECTS_PATH, path.resolve(this.vaultPath).replace(/[^a-zA-Z0-9]/g, '-'));
  }

  /**
   * List SDK native sessions from ~/.claude/projects/{dir}/
   */
  async listSDKSessions(): Promise<SessionMetadata[]> {
    const metas: SessionMetadata[] = [];
    const sdkProjectDir = this.getSDKProjectDir();

    try {
      if (!fs.existsSync(sdkProjectDir)) {
        return metas;
      }

      const files = fs.readdirSync(sdkProjectDir, { withFileTypes: true });

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;

        const sessionId = file.name.replace('.jsonl', '');
        const filePath = path.join(sdkProjectDir, file.name);

        try {
          // Read first line to get basic info
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());

          if (lines.length === 0) continue;

          // Try to find corresponding metadata file
          const metaPath = path.join(sdkProjectDir, `${sessionId}.meta.json`);
          let meta: SessionMetadata | null = null;

          if (fs.existsSync(metaPath)) {
            try {
              const metaContent = fs.readFileSync(metaPath, 'utf-8');
              meta = JSON.parse(metaContent) as SessionMetadata;
            } catch {
              // Ignore invalid metadata
            }
          }

          if (meta) {
            metas.push(meta);
          } else {
            // Create minimal metadata from SDK session
            const firstLine = lines[0];
            try {
              const parsed = JSON.parse(firstLine);
              if (parsed.type === 'error' || parsed.type === 'initiation_status') {
                // Skip error/status messages
                continue;
              }

              // Use timestamp from file or current time
              const stats = fs.statSync(filePath);
              const timestamp = Math.floor(stats.mtimeMs / 1000);

              metas.push({
                id: sessionId,
                title: sessionId.slice(0, 8), // Use first 8 chars as title
                createdAt: timestamp,
                updatedAt: timestamp,
                lastResponseAt: timestamp,
                sessionId,
                sdkSessionId: sessionId,
              } as SessionMetadata);
            } catch {
              // Skip invalid sessions
            }
          }
        } catch {
          // Skip files that fail to load
        }
      }
    } catch {
      // Return empty list if directory listing fails
    }

    return metas;
  }

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

  async saveConversation(conversation: Conversation): Promise<void> {
    const filePath = this.getFilePath(conversation.id);
    const content = this.serializeToJSONL(conversation);
    await this.adapter.write(filePath, content);
  }

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

  async loadAllConversations(): Promise<{ conversations: Conversation[]; failedCount: number }> {
    const conversations: Conversation[] = [];
    let failedCount = 0;

    // 1. Load legacy conversations from vault
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
    } catch {
      // Return empty list if directory listing fails
    }

    // 2. Load SDK sessions from ~/.claude/projects/{dir}/
    try {
      const sdkProjectDir = this.getSDKProjectDir();
      if (fs.existsSync(sdkProjectDir)) {
        const files = fs.readdirSync(sdkProjectDir, { withFileTypes: true });

        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;

          const sessionId = file.name.replace('.jsonl', '');

          // Skip if already loaded from vault
          if (conversations.some(c => c.sdkSessionId === sessionId)) continue;

          try {
            const metaPath = path.join(sdkProjectDir, `${sessionId}.meta.json`);
            let meta: SessionMetadata | null = null;

            if (fs.existsSync(metaPath)) {
              try {
                const metaContent = fs.readFileSync(metaPath, 'utf-8');
                meta = JSON.parse(metaContent) as SessionMetadata;
              } catch {
                // Ignore invalid metadata
              }
            }

            // Create minimal Conversation object
            const stats = fs.statSync(path.join(sdkProjectDir, file.name));
            const timestamp = Math.floor(stats.mtimeMs / 1000);

            const conversation: Conversation = {
              id: meta?.id || sessionId,
              title: meta?.title || sessionId.slice(0, 8),
              messages: [], // SDK sessions store messages separately
              createdAt: meta?.createdAt || timestamp,
              updatedAt: meta?.updatedAt || timestamp,
              lastResponseAt: meta?.lastResponseAt || timestamp,
              sessionId: sessionId,
              sdkSessionId: sessionId,
              isNative: true,
            };

            conversations.push(conversation);
          } catch {
            // Skip failed sessions
          }
        }
      }
    } catch {
      // Continue if SDK session loading fails
    }

    conversations.sort((a, b) => (b.lastResponseAt ?? b.updatedAt) - (a.lastResponseAt ?? a.updatedAt));

    return { conversations, failedCount };
  }

  async hasSessions(): Promise<boolean> {
    const files = await this.adapter.listFiles(SESSIONS_PATH);
    return files.some(f => f.endsWith('.jsonl'));
  }

  getFilePath(id: string): string {
    return `${SESSIONS_PATH}/${id}.jsonl`;
  }

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
      const record: SessionMessageRecord = {
        type: 'message',
        message,
      };
      lines.push(JSON.stringify(record));
    }

    return lines.join('\n');
  }

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

  /** List all native session metadata (.meta.json files without .jsonl counterparts). */
  async listNativeMetadata(): Promise<SessionMetadata[]> {
    const metas: SessionMetadata[] = [];

    try {
      const files = await this.adapter.listFiles(SESSIONS_PATH);

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
   * List all conversations, merging legacy JSONL, native metadata, and SDK sessions.
   * Legacy conversations take precedence if both exist.
   */
  async listAllConversations(): Promise<ConversationMeta[]> {
    const metas: ConversationMeta[] = [];
    const seenIds = new Set<string>();

    // 1. Load legacy conversations (existing .jsonl files)
    const legacyMetas = await this.listConversations();
    for (const meta of legacyMetas) {
      metas.push(meta);
      seenIds.add(meta.id);
    }

    // 2. Load native metadata (.meta.json files in vault)
    const nativeMetas = await this.listNativeMetadata();
    for (const meta of nativeMetas) {
      if (!seenIds.has(meta.id)) {
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
        seenIds.add(meta.id);
      }
    }

    // 3. Load SDK sessions from ~/.claude/projects/{dir}/
    const sdkSessions = await this.listSDKSessions();
    for (const meta of sdkSessions) {
      if (!seenIds.has(meta.id)) {
        metas.push({
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          lastResponseAt: meta.lastResponseAt,
          messageCount: 0,
          preview: 'SDK session',
          titleGenerationStatus: meta.titleGenerationStatus,
          isNative: true,
        });
        seenIds.add(meta.id);
      }
    }

    // 4. Sort by lastResponseAt descending (fallback to createdAt)
    return metas.sort((a, b) =>
      (b.lastResponseAt ?? b.createdAt) - (a.lastResponseAt ?? a.createdAt)
    );
  }

  toSessionMetadata(conversation: Conversation): SessionMetadata {
    const subagentData = this.extractSubagentData(conversation.messages);

    return {
      id: conversation.id,
      title: conversation.title,
      titleGenerationStatus: conversation.titleGenerationStatus,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      sessionId: conversation.sessionId,
      sdkSessionId: conversation.sdkSessionId,
      previousSdkSessionIds: conversation.previousSdkSessionIds,
      currentNote: conversation.currentNote,
      externalContextPaths: conversation.externalContextPaths,
      enabledMcpServers: conversation.enabledMcpServers,
      usage: conversation.usage,
      legacyCutoffAt: conversation.legacyCutoffAt,
      subagentData: Object.keys(subagentData).length > 0 ? subagentData : undefined,
      resumeSessionAt: conversation.resumeSessionAt,
      forkSource: conversation.forkSource,
    };
  }

  /**
   * Extracts subagentData from messages for persistence.
   * Collects subagent info from all assistant messages.
   */
  private extractSubagentData(messages: ChatMessage[]): Record<string, SubagentInfo> {
    const result: Record<string, SubagentInfo> = {};

    for (const msg of messages) {
      if (msg.role !== 'assistant' || !msg.subagents) continue;

      for (const subagent of msg.subagents) {
        result[subagent.id] = subagent;
      }
    }

    return result;
  }

}
