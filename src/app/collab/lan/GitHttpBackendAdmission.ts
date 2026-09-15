export class GitHttpBackendAdmission {
  private activeChildren = 0;

  constructor(private readonly limit = 8) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Invalid Git child limit');
    }
  }

  tryAcquire(): (() => void) | null {
    if (this.activeChildren >= this.limit) return null;
    this.activeChildren += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeChildren -= 1;
    };
  }
}
