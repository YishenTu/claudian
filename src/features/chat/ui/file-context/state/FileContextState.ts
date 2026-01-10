/**
 * File context session state.
 */

/** Escape special regex characters in a string. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class FileContextState {
  private attachedFiles: Set<string> = new Set();
  private sessionStarted = false;
  private mentionedMcpServers: Set<string> = new Set();
  private currentNoteSent = false;
  /** Maps display name (e.g., "@folder/file.ts") to absolute path for context files. */
  private contextFileMap: Map<string, string> = new Map();

  getAttachedFiles(): Set<string> {
    return new Set(this.attachedFiles);
  }

  hasSentCurrentNote(): boolean {
    return this.currentNoteSent;
  }

  markCurrentNoteSent(): void {
    this.currentNoteSent = true;
  }

  isSessionStarted(): boolean {
    return this.sessionStarted;
  }

  startSession(): void {
    this.sessionStarted = true;
  }

  resetForNewConversation(): void {
    this.sessionStarted = false;
    this.currentNoteSent = false;
    this.attachedFiles.clear();
    this.contextFileMap.clear();
    this.clearMcpMentions();
  }

  resetForLoadedConversation(hasMessages: boolean): void {
    this.currentNoteSent = hasMessages;
    this.attachedFiles.clear();
    this.contextFileMap.clear();
    this.sessionStarted = hasMessages;
    this.clearMcpMentions();
  }

  setAttachedFiles(files: string[]): void {
    this.attachedFiles.clear();
    for (const file of files) {
      this.attachedFiles.add(file);
    }
  }

  attachFile(path: string): void {
    this.attachedFiles.add(path);
  }

  /** Attach a context file with display name to absolute path mapping. */
  attachContextFile(displayName: string, absolutePath: string): void {
    this.attachedFiles.add(absolutePath);
    this.contextFileMap.set(displayName, absolutePath);
  }

  detachFile(path: string): void {
    this.attachedFiles.delete(path);
  }

  clearAttachments(): void {
    this.attachedFiles.clear();
    this.contextFileMap.clear();
  }

  /** Transform text by replacing context file display names with absolute paths. */
  transformContextMentions(text: string): string {
    let result = text;
    for (const [displayName, absolutePath] of this.contextFileMap) {
      // Replace @folder/file.ts with absolute path
      result = result.replace(new RegExp(escapeRegExp(displayName), 'g'), absolutePath);
    }
    return result;
  }

  getMentionedMcpServers(): Set<string> {
    return new Set(this.mentionedMcpServers);
  }

  clearMcpMentions(): void {
    this.mentionedMcpServers.clear();
  }

  setMentionedMcpServers(mentions: Set<string>): boolean {
    const changed =
      mentions.size !== this.mentionedMcpServers.size ||
      [...mentions].some(name => !this.mentionedMcpServers.has(name));

    if (changed) {
      this.mentionedMcpServers = new Set(mentions);
    }

    return changed;
  }

  addMentionedMcpServer(name: string): void {
    this.mentionedMcpServers.add(name);
  }
}
