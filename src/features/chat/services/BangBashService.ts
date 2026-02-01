import { exec } from 'child_process';

export interface BangBashResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB

export class BangBashService {
  private cwd: string;
  private enhancedPath: string;

  constructor(cwd: string, enhancedPath: string) {
    this.cwd = cwd;
    this.enhancedPath = enhancedPath;
  }

  execute(command: string): Promise<BangBashResult> {
    return new Promise((resolve) => {
      exec(command, {
        cwd: this.cwd,
        env: { ...process.env, PATH: this.enhancedPath },
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      }, (error, stdout, stderr) => {
        if (error && 'killed' in error && error.killed) {
          resolve({
            command,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: 124,
            error: `Command timed out after ${TIMEOUT_MS / 1000}s`,
          });
          return;
        }

        resolve({
          command,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: error?.code ?? 0,
          error: error && !('code' in error) ? error.message : undefined,
        });
      });
    });
  }
}
