import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { readWSLExec } from '@test/helpers/WSLLaunch';
import { localWSLExecutable } from '@test/helpers/WSLShellFixture';

import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import type { ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';

export const captureShells = ['bash', 'dash', 'busybox'].map(name => ({ name, executable: localWSLExecutable(name) }));
export const hasProcessGroups = process.platform === 'linux' && Boolean(localWSLExecutable('setsid'));

/** Runs the production POSIX script on a local shell; each fixture owns its files and processes. */
export async function createWSLCaptureFixture(
  executable: string,
  onFinished: (cleanup: () => Promise<void>) => void = onTestFinished,
) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-capture-'));
  // Bash and BusyBox select their sh behavior from argv[0], including through a symlink.
  const shell = path.join(root, 'sh');
  await fs.symlink(executable, shell);
  await fs.writeFile(path.join(root, '.bash_profile'), '. "$HOME/.bashrc"\n');
  const children: ReturnType<typeof spawn>[] = [];

  function launchOptions(command = '/bin/sh'): ManagedStdioProcessOptions {
    const spec = buildTargetLaunchSpec({
      target: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' },
      hostCwd: 'C:\\vault', env: {}, command, args: ['-c', 'printf "CLI_OK:%s" "$OPENAI_API_KEY"; umask'],
    });
    return { command: shell, args: readWSLExec(spec).args, cwd: root, env: {
      ...spec.env, PATH: '/usr/bin:/bin', SHELL: '/bin/bash', HOME: root, OPENAI_API_KEY: 'base-key',
    } };
  }

  function start(command?: string) {
    const options = launchOptions(command);
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    child.stdin.end();
    return { child, closed };
  }

  async function captureFile(): Promise<string> {
    let file = '';
    await vi.waitFor(async () => { file = await fs.readFile(path.join(root, 'capture-path'), 'utf8'); expect(file).not.toBe(''); });
    return file;
  }

  /** Resolves when startup atomically publishes `name`; a filesystem event, so it needs no timer. */
  function captureStarted(name: 'capture-path' | 'blocking-pid' = 'capture-path'): Promise<void> {
    const published = path.join(root, name);
    return new Promise((resolve, reject) => {
      const watcher = watch(root, () => { if (existsSync(published)) { watcher.close(); resolve(); } });
      watcher.once('error', reject);
      if (existsSync(published)) { watcher.close(); resolve(); }
    });
  }

  let disposed = false;
  const fixture = {
    root, launchOptions, start, captureFile, captureStarted,
    async startup(body: string) {
      await fs.writeFile(path.join(root, '.bashrc'), `printf '%s' "$CLAUDIAN_WSL_ENV_FILE" > "$HOME/capture-path.tmp"
printf '%s' "$$" > "$HOME/capture-pid.tmp"
mv "$HOME/capture-pid.tmp" "$HOME/capture-pid"
mv "$HOME/capture-path.tmp" "$HOME/capture-path"
${body}
`);
    },
    async capturePid() { return Number(await fs.readFile(path.join(root, 'capture-pid'), 'utf8')); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (const name of ['capture-pid', 'blocking-pid']) {
        const pid = Number(await fs.readFile(path.join(root, name), 'utf8').catch(() => '0'));
        try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
      const file = await fs.readFile(path.join(root, 'capture-path'), 'utf8').catch(() => '');
      if (file) await fs.rm(file, { force: true });
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  onFinished(() => fixture.dispose());
  return fixture;
}
