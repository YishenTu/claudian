import { ManagedStdioProcess, type ManagedStdioProcessOptions } from './ManagedStdioProcess';

/** Runs a bounded, read-only command without sharing a chat process. */
export async function runProcessProbe(
  options: ManagedStdioProcessOptions,
  timeoutMs = 5_000,
): Promise<string | null> {
  const process = new ManagedStdioProcess(options);
  let output = '';
  let timer: number | undefined;
  try {
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      };
      process.onError(() => finish(null));
      process.onClose(({ code, error }) => finish(code === 0 && !error ? output : null));
      timer = window.setTimeout(() => finish(null), timeoutMs);
      process.start();
      process.stdin.end();
      process.stdout.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        output += chunk.toString();
        if (Buffer.byteLength(output) > 16_384) finish(null);
      });
    });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    await process.shutdown();
  }
}
