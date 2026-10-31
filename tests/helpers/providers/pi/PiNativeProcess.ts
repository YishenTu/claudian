import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** Native Pi records only; kernel, subprocess wrapper, transport and normalization stay real. */
export class PiNativeProcess {
  private readonly requestEvents = new EventEmitter();
  readonly requests: Array<{ payload: Record<string, unknown>; type: string }> = [];
  readonly child: ChildProcessWithoutNullStreams;
  readonly launchSpec: { cwd?: string };

  constructor(
    options: { cwd?: string },
    responses: Map<string, unknown>,
    handle?: <T>(type: string, payload: Record<string, unknown>) => Promise<T>,
  ) {
    this.launchSpec = options;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdio: [PassThrough, PassThrough, PassThrough, null, null] = [stdin, stdout, stderr, null, null];
    const child = Object.assign(new ChildProcess(), {
      stdin, stdout, stderr, stdio,
      exitCode: null as number | null, killed: false, pid: 12345,
      kill: () => { child.killed = true; this.close(); return true; },
    });
    this.child = child;
    let buffered = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const { id, type, ...payload } = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        this.requests.push({ type, payload });
        this.requestEvents.emit(type);
        void Promise.resolve().then(() => handle ? handle(type, payload) : responses.get(type)).then(
          data => this.emit({ type: 'response', id, success: true, data }),
          error => this.emit({ type: 'response', id, success: false, error: String(error) }),
        );
      }
    });
  }

  whenRequest(type: string, count = 1): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (this.requests.filter(request => request.type === type).length < count) return;
        this.requestEvents.off(type, check);
        resolve();
      };
      this.requestEvents.on(type, check);
      check();
    });
  }

  emit(record: Record<string, unknown>): void {
    if (!this.child.stdout.destroyed) this.child.stdout.push(JSON.stringify(record) + '\n');
  }

  close(): void {
    Object.defineProperty(this.child, 'exitCode', { value: 1, configurable: true });
    this.child.emit('exit', 1, null);
    this.child.emit('close', 1, null);
  }
}
