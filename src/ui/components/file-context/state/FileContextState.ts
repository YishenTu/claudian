/**
 * File context session state.
 */

export class FileContextState {
  private attachedFiles: Set<string> = new Set();
  private lastSentFiles: Set<string> = new Set();
  private sessionStarted = false;
  private planModeActive = false;
  private mentionedMcpServers: Set<string> = new Set();

  getAttachedFiles(): Set<string> {
    return new Set(this.attachedFiles);
  }

  hasFilesChanged(): boolean {
    const currentFiles = Array.from(this.attachedFiles);
    if (currentFiles.length !== this.lastSentFiles.size) return true;
    for (const file of currentFiles) {
      if (!this.lastSentFiles.has(file)) return true;
    }
    return false;
  }

  markFilesSent(): void {
    this.lastSentFiles = new Set(this.attachedFiles);
  }

  isSessionStarted(): boolean {
    return this.sessionStarted;
  }

  startSession(): void {
    this.sessionStarted = true;
  }

  resetForNewConversation(): void {
    this.sessionStarted = false;
    this.lastSentFiles.clear();
    this.attachedFiles.clear();
    this.clearMcpMentions();
  }

  resetForLoadedConversation(hasMessages: boolean): void {
    this.lastSentFiles.clear();
    this.attachedFiles.clear();
    this.sessionStarted = hasMessages;
    this.clearMcpMentions();
  }

  setAttachedFiles(files: string[]): void {
    this.attachedFiles.clear();
    for (const file of files) {
      this.attachedFiles.add(file);
    }
    this.lastSentFiles = new Set(this.attachedFiles);
  }

  attachFile(path: string): void {
    this.attachedFiles.add(path);
  }

  detachFile(path: string): void {
    this.attachedFiles.delete(path);
  }

  clearAttachments(): void {
    this.attachedFiles.clear();
  }

  setPlanModeActive(active: boolean): void {
    this.planModeActive = active;
  }

  isPlanModeActive(): boolean {
    return this.planModeActive;
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
