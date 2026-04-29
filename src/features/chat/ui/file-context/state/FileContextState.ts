export class FileContextState {
  private attachedFiles: Set<string> = new Set();
  private sessionStarted = false;
  private mentionedMcpServers: Set<string> = new Set();
  private currentNoteSent = false;
  private lineRangeMentions: Map<string, { startLine: number; endLine: number }> = new Map();


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
    this.clearMcpMentions();
    this.lineRangeMentions.clear();
  }

  resetForLoadedConversation(hasMessages: boolean): void {
    this.currentNoteSent = hasMessages;
    this.attachedFiles.clear();
    this.sessionStarted = hasMessages;
    this.clearMcpMentions();
    this.lineRangeMentions.clear();
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

  detachFile(path: string): void {
    this.attachedFiles.delete(path);
  }

  clearAttachments(): void {
    this.attachedFiles.clear();
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

  getLineRangeMentions(): Map<string, { startLine: number; endLine: number }> {
    return new Map(this.lineRangeMentions);
  }

  attachLineRangeMention(filePath: string, startLine: number, endLine: number): void {
    this.lineRangeMentions.set(filePath, { startLine, endLine });
  }

  removeLineRangeMention(filePath: string): void {
    this.lineRangeMentions.delete(filePath);
  }
}

