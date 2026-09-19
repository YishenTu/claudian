/** Plugin-lifetime admission for the single pending or visible inline edit. */
export class InlineEditSessionOwner {
  private active: { close(): void } | null = null;
  private disposed = false;

  claim(close: () => void): (() => void) | null {
    if (this.disposed) return null;
    if (this.active) {
      this.active.close();
      return null;
    }
    const operation = { close };
    this.active = operation;
    return () => {
      if (this.active === operation) this.active = null;
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    this.active = null;
    active?.close();
  }
}
