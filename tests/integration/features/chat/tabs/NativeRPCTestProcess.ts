import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** A native-process boundary; the production process wrappers and RPC transports remain real. */
export function createNativeRPCProcess(
  handle: (method: string, params: Record<string, any>, notify: (method: string, params: unknown) => void) => unknown,
): ChildProcessWithoutNullStreams {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null, killed: false, pid: 12345,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() {
      proc.exitCode = 0;
      proc.killed = true;
      proc.emit('exit', 0, null);
      proc.emit('close', 0, null);
      return true;
    },
  });
  const write = (record: unknown) => proc.stdout.write(JSON.stringify(record) + '\n');
  const notify = (method: string, params: unknown) => { write({ jsonrpc: '2.0', method, params }); };
  let buffer = '';
  proc.stdin.on('data', (data: Buffer) => {
    buffer += data.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.id === undefined || !message.method) continue;
      void Promise.resolve().then(() => handle(message.method, message.params ?? {}, notify)).then(
        result => write({ jsonrpc: '2.0', id: message.id, result }),
        error => write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error) } }),
      );
    }
  });
  return proc as unknown as ChildProcessWithoutNullStreams;
}

/** A CLI version probe exits without opening an RPC session. */
export function createNativeVersionProcess(version: string): ChildProcessWithoutNullStreams {
  const proc = createNativeRPCProcess(() => undefined);
  queueMicrotask(() => {
    (proc.stdout as PassThrough).write(`${version}\n`);
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
  });
  return proc;
}
