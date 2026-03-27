export class CodexSessionManager {
  private threadId: string | null = null;
  private sessionFilePath: string | null = null;
  private sessionInvalidated = false;

  getThreadId(): string | null {
    return this.threadId;
  }

  getSessionFilePath(): string | null {
    return this.sessionFilePath;
  }

  setThread(threadId: string, sessionFilePath?: string): void {
    const threadChanged = this.threadId !== threadId;
    this.threadId = threadId;
    if (sessionFilePath) {
      this.sessionFilePath = sessionFilePath;
    } else if (threadChanged) {
      this.sessionFilePath = null;
    }
  }

  reset(): void {
    this.threadId = null;
    this.sessionFilePath = null;
    this.sessionInvalidated = false;
  }

  invalidateSession(): void {
    this.sessionInvalidated = true;
  }

  consumeInvalidation(): boolean {
    const was = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return was;
  }
}
