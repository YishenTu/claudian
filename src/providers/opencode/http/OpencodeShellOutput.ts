import type { OpencodeServerLease } from './OpencodeServerService';

/** A best-effort preview; native tool completion always supplies the authoritative result. */
export class OpencodeShellOutput {
  private readonly controller = new AbortController();
  private timer: number | undefined;
  private cursor = 0;

  constructor(
    private readonly client: OpencodeServerLease,
    private readonly shellId: string,
    private readonly emit: (text: string) => void,
  ) {
    void this.read();
  }

  stop(): void {
    this.controller.abort();
    window.clearTimeout(this.timer);
  }

  private async read(): Promise<void> {
    const signal = this.controller.signal;
    try {
      const { data } = await this.client.request<{ data: { output: string; cursor: number } }>(
        `/api/shell/${encodeURIComponent(this.shellId)}/output?cursor=${this.cursor}&limit=65536`, { signal },
      );
      if (signal.aborted) return;
      if (!data || typeof data.output !== 'string' || !Number.isSafeInteger(data.cursor)
        || data.cursor < this.cursor || (data.output && data.cursor === this.cursor)) {
        this.stop();
        return;
      }
      this.cursor = data.cursor;
      if (data.output) this.emit(data.output);
      // Keep live previews bounded; the final native result replaces them on completion.
      if (this.cursor >= 1024 * 1024) this.stop();
      if (!signal.aborted) this.timer = window.setTimeout(() => { void this.read(); }, 100);
    } catch {
      // Unsupported/expired shells or cancelled readers must not fail the native turn.
      this.stop();
    }
  }
}
