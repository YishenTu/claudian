import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PiSubprocess } from '@/providers/pi/runtime/PiSubprocess';

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;

describeOnWindows('PiSubprocess Windows argv integration', () => {
  it('preserves opaque arguments after bypassing the npm command shim', async () => {
    const npmPrefix = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-argv-integration-'));
    const packageRoot = path.join(
      npmPrefix,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
    );
    const cliPath = path.join(packageRoot, 'dist', 'bundle', 'cli.js');
    const commandPath = path.join(npmPrefix, 'pi.cmd');
    const expectedArgs = [
      '--mode',
      'rpc',
      '--system-prompt',
      'First line\r\nSecond line with "%PATH%" and !caret^',
      '--session',
      'D:\\文档\\Pi Sessions\\session.jsonl',
    ];
    let subprocess: PiSubprocess | null = null;

    try {
      await fs.mkdir(path.dirname(cliPath), { recursive: true });
      await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
        bin: { pi: 'dist/bundle/cli.js' },
        name: '@earendil-works/pi-coding-agent',
      }));
      await fs.writeFile(cliPath, [
        'process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\\n`);',
        'process.stdin.resume();',
      ].join('\n'));
      await fs.writeFile(commandPath, createWindowsCommandShim(commandPath, cliPath));

      subprocess = new PiSubprocess({
        args: expectedArgs,
        command: commandPath,
        cwd: npmPrefix,
        env: { ...process.env },
      });
      subprocess.start();

      await expect(readFirstLine(subprocess)).resolves.toEqual(expectedArgs);
    } finally {
      await subprocess?.shutdown();
      await fs.rm(npmPrefix, { force: true, recursive: true });
    }
  });
});

function createWindowsCommandShim(commandPath: string, targetPath: string): string {
  const relativeTarget = path.relative(path.dirname(commandPath), targetPath)
    .split(path.sep)
    .join('\\');
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeTarget}" %*`,
    '',
  ].join('\r\n');
}

function readFirstLine(subprocess: PiSubprocess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the Pi argv fixture'));
    }, 10_000);
    const onData = (chunk: Buffer | string): void => {
      buffered += chunk.toString();
      const newlineIndex = buffered.indexOf('\n');
      if (newlineIndex < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(buffered.slice(0, newlineIndex)) as unknown);
      } catch (error) {
        reject(error);
      }
    };
    const removeCloseListener = subprocess.onClose(error => {
      cleanup();
      reject(error ?? new Error('Pi argv fixture exited before producing output'));
    });
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      subprocess.stdout.off('data', onData);
      removeCloseListener();
    };
    subprocess.stdout.on('data', onData);
  });
}
