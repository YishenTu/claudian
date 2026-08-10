export class FileContextState {
  private attachedFiles: Set<string> = new Set();
  private sessionStarted = false;
  private currentNoteSent = false;

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
  }

  resetForLoadedConversation(hasMessages: boolean): void {
    this.currentNoteSent = hasMessages;
    this.attachedFiles.clear();
    this.sessionStarted = hasMessages;
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
}
