import { ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { readWSLExec } from '@test/helpers/WSLLaunch';

export interface WSLProcessRequest {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  executable: string;
  argv: string[];
}
export interface WSLProcessReply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/** The OS process boundary; target/probe/CLI modules stay real. Unknown commands fail loudly. */
export class WSLProcessFixture {
  readonly requests: WSLProcessRequest[] = [];
  environment: Record<string, string | undefined> = {};
  readonly binaries = new Map<string, { path: string; version: string }>();
  reply: ((request: WSLProcessRequest) => WSLProcessReply | undefined) | undefined;

  readonly spawn = (command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess => {
    if (!/(?:^|[\\/])wsl\.exe$/u.test(command)) throw new Error(`Unexpected WSL process: ${command}`);
    if (!options.windowsVerbatimArguments) throw new Error('WSL launch must preserve Windows argv');
    const exec = readWSLExec({ args: [...args] });
    if (exec.command !== '/bin/sh' || exec.args[0] !== '-c') throw new Error('Expected WSL shell launch');
    const [executable, ...argv] = exec.args.slice(3);
    const request = { command, args, options, executable, argv };
    this.requests.push(request);
    const reply = this.reply?.(request) ?? this.respond(request);
    const child = new WSLTestProcess();
    queueMicrotask(() => child.complete(reply));
    return child;
  };

  private respond({ executable, argv }: WSLProcessRequest): WSLProcessReply {
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
}

class WSLTestProcess extends ChildProcess implements ChildProcessWithoutNullStreams {
  override readonly stdin = new PassThrough();
  override readonly stdout = new PassThrough();
  override readonly stderr = new PassThrough();
  override readonly stdio: ChildProcessWithoutNullStreams['stdio'] = [this.stdin, this.stdout, this.stderr, null, null];
  override pid = 12345;
  override killed = false;
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;

  complete(reply: WSLProcessReply): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.stdout.end(reply.stdout ?? '');
    this.stderr.end(reply.stderr ?? '');
    this.exitCode = reply.code ?? 0;
    this.emit('exit', this.exitCode, null);
    this.emit('close', this.exitCode, null);
  }

  override kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    this.emit('close', null, this.signalCode);
    return true;
  }
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
    fail: () => fs.writeFile(path.join(root, 'fail'), ''),
    delay: (milliseconds: number) => fs.writeFile(path.join(root, 'delay'), String(milliseconds)),
  };
}
