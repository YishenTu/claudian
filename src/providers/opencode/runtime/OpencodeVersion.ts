import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';

/** The only supported native major. */
type OpencodeNativeVersion = 2;

export function parseOpencodeNativeVersion(version: string | undefined | null): OpencodeNativeVersion | undefined {
  if (!version) return undefined;
  const major = Number(version.match(/^(\d+)\./u)?.[1]);
  if (major === 2) return major;
  if (major === 1) throw new Error('OpenCode v1 is no longer supported. Update to OpenCode v2.');
  throw new Error(`Unsupported OpenCode version: ${version}. Use OpenCode v2.`);
}

/** The configured OpenCode CLI is absent, so no native server can launch. */
export class OpencodeCLINotInstalledError extends Error {
  readonly name = 'OpencodeCLINotInstalledError';
  constructor() { super('OpenCode CLI was not found. Check the CLI path and installation.'); }
}

/** Rejects a missing CLI or any installed major other than v2. */
export async function verifyOpencodeNativeVersion(
  cliPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<OpencodeNativeVersion> {
  const installation = await probeCLIInstallation({
    path: cliPath,
    configuredPath: cliPath,
    args: ['--version'],
    env: environment,
  });
  if (!installation.path) throw new OpencodeCLINotInstalledError();
  const version = parseOpencodeNativeVersion(installation.version);
  if (!version) throw new Error('Could not determine the OpenCode version. Check the CLI path and installation.');
  return version;
}
