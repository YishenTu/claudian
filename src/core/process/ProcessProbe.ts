import { ManagedStdioProcess, type ManagedStdioProcessOptions } from './ManagedStdioProcess';

/** Runs a bounded, read-only command without sharing a chat process. */
export async function runProcessProbe(
  options: ManagedStdioProcessOptions,
  timeoutMs = 5_000,
): Promise<string | null> {
  const output: Buffer[] = [];
  let outputBytes = 0;
  let timer: number | undefined;
  let settled = false;
  let finish: (value: string | null) => void = () => undefined;
  const process = new ManagedStdioProcess({
    ...options,
    onStdoutData: (chunk) => {
      if (settled) return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      outputBytes += bytes.length;
      if (outputBytes > 16_384) {
        finish(null);
        return;
      }
      output.push(bytes);
    },
  });
  try {
    return await new Promise<string | null>((resolve) => {
      finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      };
      process.onError(() => finish(null));
      process.onClose(({ code, error }) => finish(
          code === 0 && !error ? Buffer.concat(output).toString('utf8') : null,
      ));
      timer = window.setTimeout(() => finish(null), timeoutMs);
      process.start();
      process.stdin.end();
    });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    await process?.shutdown();
  }
}
