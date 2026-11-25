import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** Native Pi records only; kernel, subprocess wrapper, transport and normalization stay real. */
export class PiNativeProcess {
  private readonly requestEvents = new EventEmitter();
  private exitOnStdinEnd = true;
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
    // Pi's RPC mode shuts down in order and exits once its stdin ends.
    child.stdin.on('end', () => { if (this.exitOnStdinEnd) this.#exit(0); });
  }

  /** Keeps running after stdin ends, as a Pi still finishing shutdown work does, until `close()`. */
  holdExit(): void {
    this.exitOnStdinEnd = false;
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
    this.#exit(1);
  }

  #exit(code: number): void {
    if (this.child.exitCode !== null) return;
    Object.defineProperty(this.child, 'exitCode', { value: code, configurable: true });
    this.child.emit('exit', code, null);
    this.child.emit('close', code, null);
  }
}
