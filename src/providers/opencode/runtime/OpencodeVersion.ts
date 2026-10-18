import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';

/** The native stamp persisted with conversations bound by OpenCode v2. */
export type OpencodeNativeVersion = 2;

export function parseOpencodeNativeVersion(version: string | undefined | null): OpencodeNativeVersion | undefined {
  if (!version) return undefined;
  const major = Number(version.match(/^(\d+)\./u)?.[1]);
  if (major === 2) return major;
  if (major === 1) throw new Error('OpenCode v1 is no longer supported. Update to OpenCode v2.');
  throw new Error(`Unsupported OpenCode version: ${version}. Use OpenCode v2.`);
}

/** Resolves `undefined` only when the CLI is not installed. */
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
