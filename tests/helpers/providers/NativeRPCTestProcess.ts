import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

type NativeRPCHandler = (
  method: string,
  params: Record<string, unknown>,
  notify: (method: string, params: unknown) => void,
) => unknown;

export interface NativeRPCPeer {
  readonly child: ChildProcessWithoutNullStreams;
  /** Sends a peer-initiated JSON-RPC request and resolves with the client's result. */
  request(method: string, params: unknown): Promise<unknown>;
}

/** A native-process boundary; the production process wrappers and RPC transports remain real. */
export function createNativeRPCPeer(
  handle: NativeRPCHandler,
  onNotification?: (method: string, params: Record<string, unknown>) => void,
): NativeRPCPeer {
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
  const pending = new Map<string, { reject: (error: Error) => void; resolve: (result: unknown) => void }>();
  let nextRequestId = 0;
  let buffer = '';
  proc.stdin.on('data', (data: Buffer) => {
    buffer += data.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message: {
        error?: { message?: string };
        id?: number | string;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
      } = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      const { id, method, params = {} } = message;
      if (id === undefined) {
        if (method) onNotification?.(method, params);
        continue;
      }
      if (!method) {
        const waiter = pending.get(String(id));
        pending.delete(String(id));
        if (message.error) waiter?.reject(new Error(message.error.message ?? 'Client error'));
        else waiter?.resolve(message.result);
        continue;
      }
      void Promise.resolve().then(() => handle(method, params, notify)).then(
        result => write({ jsonrpc: '2.0', id, result }),
        error => write({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error) } }),
      );
    }
  });
  return {
    child: proc as unknown as ChildProcessWithoutNullStreams,
    request(method, params) {
      const id = `peer-${++nextRequestId}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { reject, resolve });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
  };
}

export function createNativeRPCProcess(handle: NativeRPCHandler): ChildProcessWithoutNullStreams {
  return createNativeRPCPeer(handle).child;
}
