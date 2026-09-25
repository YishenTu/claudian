import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';

export type OpencodeNativeVersion = 1 | 2;

export function parseOpencodeNativeVersion(version: string | undefined | null): OpencodeNativeVersion | undefined {
  if (!version) return undefined;
  const major = Number(version.match(/^(\d+)\./u)?.[1]);
  if (major === 1 || major === 2) return major;
  throw new Error(`Unsupported OpenCode version: ${version}. Use OpenCode v1 or v2.`);
}

export async function detectOpencodeNativeVersion(
  cliPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<OpencodeNativeVersion | undefined> {
  const installation = await probeCLIInstallation({
    path: cliPath,
    configuredPath: cliPath,
    args: ['--version'],
    env: environment,
  });
  if (installation.path && !installation.version) {
    throw new Error('Could not determine the OpenCode version. Check the CLI path and installation.');
  }
  return parseOpencodeNativeVersion(installation.version);
}

export function assertOpencodeSessionCompatibility(
  storedVersion: OpencodeNativeVersion | undefined,
  runtimeVersion: OpencodeNativeVersion | undefined,
): void {
  if (storedVersion === 2 && runtimeVersion !== 2) {
    throw new Error('This conversation requires OpenCode v2. Update OpenCode to resume or fork it.');
  }
}
