import * as path from 'node:path';

/** A target PATH can be Linux-only, so locate the Windows launcher independently. */
export function getWSLExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return systemRoot ? path.win32.join(systemRoot, 'System32', 'wsl.exe') : 'wsl.exe';
}
