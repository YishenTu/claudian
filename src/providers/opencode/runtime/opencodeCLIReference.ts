import { getInstallationKey } from '@/core/device/InstallationKey';
import { isWindowsStyleCLIReference, stripSurroundingQuotes } from '@/core/process/cliPath';

export function resolveOpencodeWSLCLIPath(config: { cliPath: string; cliPathsByHost: Record<string, string> }): string {
  return [config.cliPathsByHost[getInstallationKey()], config.cliPath]
    .map(value => stripSurroundingQuotes((value ?? '').trim()))
    .find(value => value && !isWindowsStyleCLIReference(value)) || 'opencode';
}
