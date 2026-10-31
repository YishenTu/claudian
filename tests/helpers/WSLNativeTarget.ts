import { execFileSync } from 'node:child_process';

import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import { getWSLExecutable } from '@/core/process/execution-target/WSLExecutable';

/** Native suites skip developer machines without WSL; the dedicated CI job must run. */
export function hasNativeWSL(): boolean {
  let available = false;
  if (process.platform === 'win32') {
    const target = resolveExecutionTarget({ settings: { installationMethod: 'wsl', wslDistroOverride: '' } });
    if (target.distroName) {
      try {
        execFileSync(getWSLExecutable(), ['--distribution', target.distroName, '--exec', '/bin/true'], { timeout: 20_000, windowsHide: true });
        available = true;
      } catch { /* Optional on developer machines. */ }
    }
  }
  if (!available && process.env.CLAUDIAN_REQUIRE_WSL === '1') throw new Error('The WSL CI job requires a running distro; native tests must not skip.');
  return available;
}
