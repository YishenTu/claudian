function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class FileContextState {
  private attachedFiles: Set<string> = new Set();
  private sessionStarted = false;
  private mentionedMcpServers: Set<string> = new Set();
  private currentNoteSent = false;
  /** Maps display name to absolute path for external context files only. */
  private contextFileMap: Map<string, string> = new Map();
  /** Tracks which attached files have been sent in this session. */
  private sentFiles: Set<string> = new Set();
  /** Additional files attached by the user (not the current note). */
  private additionalFiles: Set<string> = new Set();

  getAttachedFiles(): Set<string> {
    return new Set(this.attachedFiles);
  }

  /** Get additional files attached by the user (excluding current note). */
  getAdditionalFiles(): Set<string> {
    return new Set(this.additionalFiles);
  }

  hasSentCurrentNote(): boolean {
    return this.currentNoteSent;
  }

  markCurrentNoteSent(): void {
    this.currentNoteSent = true;
  }

  /** Check if a specific file has been sent. */
  hasFileSent(filePath: string): boolean {
    return this.sentFiles.has(filePath);
  }

  /** Mark a file as sent. */
  markFileSent(filePath: string): void {
    this.sentFiles.add(filePath);
  }

  /** Mark all attached files as sent. */
  markAllFilesSent(): void {
    for (const file of this.attachedFiles) {
      this.sentFiles.add(file);
    }
  }

  /** Get files that haven't been sent yet. */
  getUnsentFiles(): string[] {
    return [...this.attachedFiles].filter(f => !this.sentFiles.has(f));
  }

  /** Add an additional file (user-selected, not current note). */
  addAdditionalFile(filePath: string): void {
    this.additionalFiles.add(filePath);
    this.attachedFiles.add(filePath);
  }

  /** Remove an additional file. */
  removeAdditionalFile(filePath: string): void {
    this.additionalFiles.delete(filePath);
    this.attachedFiles.delete(filePath);
    this.sentFiles.delete(filePath);
  }

  /** Check if a file is an additional file (user-selected). */
  isAdditionalFile(filePath: string): boolean {
    return this.additionalFiles.has(filePath);
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
    this.sentFiles.clear();
    this.additionalFiles.clear();
    this.clearMcpMentions();
  }

  resetForLoadedConversation(hasMessages: boolean): void {
    this.currentNoteSent = hasMessages;
    this.attachedFiles.clear();
    this.contextFileMap.clear();
    this.sentFiles.clear();
    this.additionalFiles.clear();
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

  /** Attach an external context file with display name to absolute path mapping. */
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

  /** Transform text by replacing external context file display names with absolute paths. */
  transformContextMentions(text: string): string {
    let result = text;
    for (const [displayName, absolutePath] of this.contextFileMap) {
      // Replace @contextFolder/file.ts with absolute path
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
