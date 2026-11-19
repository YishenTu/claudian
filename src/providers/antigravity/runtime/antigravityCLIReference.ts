import { getInstallationKey } from '@/core/device/InstallationKey';
import { isWindowsStyleCLIReference, stripSurroundingQuotes } from '@/core/process/cliPath';

/** The Linux command a WSL installation runs; Windows paths saved for a native installation are skipped. */
export function resolveAntigravityWSLCLIPath(config: { cliPath: string; cliPathsByHost: Record<string, string> }): string {
  return [config.cliPathsByHost[getInstallationKey()], config.cliPath]
    .map(value => stripSurroundingQuotes((value ?? '').trim()))
    .find(value => value && !isWindowsStyleCLIReference(value)) || 'agy';
}
