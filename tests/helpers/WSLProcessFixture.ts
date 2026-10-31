import { ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { readWSLExec } from '@test/helpers/WSLLaunch';

const WINDOWS_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

export interface WSLProcessRequest {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  executable: string;
  argv: string[];
  /** Text the client wrote to stdin, in order; wsl.exe forwards it to the Linux command. */
  stdin: string;
  /** Exits a process whose reply held it; it otherwise runs until killed. */
  complete(reply: WSLProcessReply): void;
  /** Writes output from a held process on a later turn, as its Linux command would; throws once output ended. */
  write(stdout: string): void;
  /** Calls the listener with each stdin chunk the Linux command receives from now on. */
  onStdin(listener: (chunk: string) => void): void;
}
export interface WSLProcessReply {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Writes any output, then keeps running until `request.complete()` or a kill. */
  hold?: boolean;
}

/** The OS process boundary; target/probe/CLI modules stay real. Unknown commands fail loudly. */
export class WSLProcessFixture {
  readonly requests: WSLProcessRequest[] = [];
  environment: Record<string, string | undefined> = {};
  readonly binaries = new Map<string, { path: string; version: string }>();
  reply: ((request: WSLProcessRequest) => WSLProcessReply | undefined) | undefined;
  /** WSL interop runs Windows executables mounted under /mnt; false models `[interop] enabled=false`. */
  interop = true;

  readonly spawn = (command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess => {
    if (!/(?:^|[\\/])wsl\.exe$/u.test(command)) throw new Error(`Unexpected WSL process: ${command}`);
    if (!options.windowsVerbatimArguments) throw new Error('WSL launch must preserve Windows argv');
    // wsl.exe is a Windows process: there is no POSIX process group, and signalling a fake pid's group would hit the test host.
    if (options.detached) throw new Error('Detached WSL process groups are not modeled');
    const exec = readWSLExec({ args: [...args] });
    if (exec.command !== '/bin/sh' || exec.args[0] !== '-c') throw new Error('Expected WSL shell launch');
    const [executable, ...argv] = exec.args.slice(3);
    const child = new WSLTestProcess();
    const request: WSLProcessRequest = {
      command, args, options, executable, argv, stdin: '',
      // The OS reports the exit later, never inside the caller's turn.
      complete: reply => { setImmediate(() => child.complete(reply)); },
      write: stdout => {
        if (child.stdout.writableEnded) throw new Error('The WSL process output has ended');
        setImmediate(() => { if (!child.stdout.writableEnded) child.stdout.write(stdout); });
      },
      onStdin: listener => { child.stdin.on('data', listener); },
    };
    child.stdin.setEncoding('utf8').on('data', (chunk: string) => { request.stdin += chunk; });
    this.requests.push(request);
    const reply = this.reply?.(request) ?? this.respond(request);
    // Node announces a started child on nextTick; output and exit come from the OS on a later turn.
    process.nextTick(() => child.emit('spawn'));
    setImmediate(() => {
      if (!reply.hold) child.complete(reply);
      else {
        if (reply.stdout) child.stdout.write(reply.stdout);
        if (reply.stderr) child.stderr.write(reply.stderr);
      }
    });
    return child;
  };

  private respond({ executable, argv, options }: WSLProcessRequest): WSLProcessReply {
    if (executable === WINDOWS_POWERSHELL) return this.runPowerShell(argv, options.env ?? {});
    if (executable === '/usr/bin/awk') {
      // Model native environment records, not the owned parser's returned object.
      return { stdout: argv.slice(1).map(key => {
        const value = this.environment[key];
        return value === undefined ? '\0\0' : `x\0${value}\0`;
      }).join('') };
    }
    if (executable === '/bin/sh' && argv[2] === 'claudian-cli-probe') {
      const binary = this.binaries.get(argv[3]);
      return binary ? { stdout: `${binary.path}\n` } : { code: 1 };
    }
    const binary = [...this.binaries.values()].find(value => value.path === executable);
    if (binary && argv.includes('--version')) return { stdout: `${binary.version}\n` };
    throw new Error(`Unsupported WSL command: ${executable} ${JSON.stringify(argv)}`);
  }

  /** Runs only the relay's credential-free readiness probe; route traffic needs the native CI job. */
  private runPowerShell(argv: readonly string[], env: NodeJS.ProcessEnv): WSLProcessReply {
    if (!this.interop) return { code: 126, stderr: `claudian: 1: exec: ${WINDOWS_POWERSHELL}: Exec format error\n` };
    const encoded = argv.at(-1);
    const script = argv.at(-2) === '-EncodedCommand' && encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : '';
    // Interop passes a Linux variable to the Windows process only when WSLENV declares it.
    const forwarded = (env.WSLENV ?? '').split(':').some(entry => entry.split('/')[0] === 'CLAUDIAN_SESSION_TOOL_MODE');
    if (!script.includes('if (mode == "probe") { Console.WriteLine("claudian-relay-ready"); return 0; }')) {
      throw new Error(`Unsupported PowerShell invocation: ${JSON.stringify(argv)}`);
    }
    const mode = forwarded ? env.CLAUDIAN_SESSION_TOOL_MODE : undefined;
    if (mode === 'probe') return { stdout: 'claudian-relay-ready\r\n' };
    // Without a mode the relay cannot build its URL and its top-level catch exits 1.
    if (mode === undefined) return { code: 1, stderr: 'Windows PowerShell could not start the session tool relay.\r\n' };
    throw new Error('Unsupported relay mode: route traffic is covered by the native WSL job');
  }
}

// Windows ChildProcess.kill() terminates wsl.exe for these; signal 0 only checks liveness; others throw.
const TERMINATING_SIGNALS = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGQUIT']);

class WSLTestProcess extends ChildProcess implements ChildProcessWithoutNullStreams {
  override readonly stdin = new PassThrough();
  override readonly stdout = new PassThrough();
  override readonly stderr = new PassThrough();
  override readonly stdio: ChildProcessWithoutNullStreams['stdio'] = [this.stdin, this.stdout, this.stderr, null, null];
  override pid = 12345;
  override killed = false;
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
  private exited = false;
  private pendingSignal: NodeJS.Signals | null = null;

  complete(reply: WSLProcessReply): void {
    if (this.exited || this.pendingSignal) return;
    this.stdout.end(reply.stdout ?? '');
    this.stderr.end(reply.stderr ?? '');
    this.exit(reply.code ?? 0, null);
  }

  override kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    const name = signalName(signal);
    if (this.exited) return false;
    if (name !== null && !TERMINATING_SIGNALS.has(name)) {
      // Windows libuv rejects other signals with UV_ENOSYS, which Node throws as an ErrnoException.
      throw Object.assign(new Error('kill ENOSYS'), { code: 'ENOSYS', errno: -constants.errno.ENOSYS, syscall: 'kill' });
    }
    // Node marks a delivered signal, including the liveness probe 0, as killed.
    this.killed = true;
    if (name === null) return true;
    // As on Windows, the latest signal before the OS reports the exit is the one published.
    if (!this.pendingSignal) setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.exit(null, this.pendingSignal);
    });
    this.pendingSignal = name;
    return true;
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

/** Returns null for the liveness probe 0; names are case-insensitive and unknown signals throw, as in Node. */
function signalName(signal: NodeJS.Signals | number): NodeJS.Signals | null {
  if (signal === 0) return null;
  const key = typeof signal === 'string' ? signal.toUpperCase() : signal;
  const name = Object.entries(constants.signals).find(([entry, value]) => entry === key || value === key)?.[0];
  if (!name) throw Object.assign(new TypeError(`Unknown signal: ${signal}`), { code: 'ERR_UNKNOWN_SIGNAL' });
  return name as NodeJS.Signals;
}

/** A real executable for default-distro discovery on POSIX test hosts. */
export async function createWSLDistroFixture(output: Buffer) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-wsl-list-'));
  await fs.writeFile(path.join(root, 'output'), output);
  await fs.writeFile(path.join(root, 'wsl.exe'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--list', '--verbose'])) process.exit(2);
if (fs.existsSync(path.join(__dirname, 'fail'))) process.exit(1);
const delayFile = path.join(__dirname, 'delay');
const delay = fs.existsSync(delayFile) ? Number(fs.readFileSync(delayFile, 'utf8')) : 0;
setTimeout(() => process.stdout.write(fs.readFileSync(path.join(__dirname, 'output'))), delay);
`, { mode: 0o755 });
  vi.stubEnv('SystemRoot', '');
  vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH ?? ''}`);
  onTestFinished(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
  return {
    setOutput: (next: Buffer) => fs.writeFile(path.join(root, 'output'), next),
    fail: () => fs.writeFile(path.join(root, 'fail'), ''),
    delay: (milliseconds: number) => fs.writeFile(path.join(root, 'delay'), String(milliseconds)),
  };
}
