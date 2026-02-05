// Simple performance tracking to add to StreamController
export const PERF_TRACKING = \`
  // Performance fields
  private perfLog: any[] = [];
  private chunkCount = 0;
  private renderCount = 0;
  private streamStartTime = 0;

  // Log to console with timestamp
  private logPerf(type: string, data: any): void {
    const entry = { type, time: Date.now(), ...data };
    this.perfLog.push(entry);
    console.log('[Claudian Perf]', entry);
  }
\`;
