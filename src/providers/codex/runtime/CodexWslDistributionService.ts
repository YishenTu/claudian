import { execFile, execFileSync } from 'child_process';

export interface CodexWslDistribution {
  name: string;
  version: 1 | 2;
  isDefault: boolean;
}

export function decodeWslCommandOutput(output: Buffer): string {
  if (output.length >= 2 && output[0] === 0xff && output[1] === 0xfe) {
    return output.subarray(2).toString('utf16le');
  }

  const zeroBytes = output.subarray(0, Math.min(output.length, 64))
    .filter(byte => byte === 0).length;
  if (zeroBytes >= 4) {
    return output.toString('utf16le').replace(/^\uFEFF/, '');
  }

  return output.toString('utf8').replace(/^\uFEFF/, '');
}

export function parseWslDistributionListOutput(output: string): CodexWslDistribution[] {
  const distributions: CodexWslDistribution[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\*)?\s*(.*?)\s{2,}.+?\s{2,}([12])\s*$/);
    if (!match) {
      continue;
    }

    distributions.push({
      name: match[2].trim(),
      version: Number(match[3]) as 1 | 2,
      isDefault: match[1] === '*',
    });
  }

  if (distributions.length === 0) {
    throw new Error('No WSL distributions were found');
  }

  return distributions;
}

function formatWslCommandError(error: unknown): Error {
  if (error instanceof Error && error.message) {
    return new Error(`Failed to get WSL distributions: ${error.message}`);
  }
  return new Error('Failed to get WSL distributions');
}

export function listCodexWslDistributions(): Promise<CodexWslDistribution[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['--list', '--verbose'],
      { encoding: 'buffer', windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(formatWslCommandError(error));
          return;
        }

        try {
          resolve(parseWslDistributionListOutput(decodeWslCommandOutput(stdout)));
        } catch (parseError) {
          reject(formatWslCommandError(parseError));
        }
      },
    );
  });
}

export function listCodexWslDistributionsSync(): CodexWslDistribution[] {
  try {
    const output = execFileSync('wsl.exe', ['--list', '--verbose'], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return parseWslDistributionListOutput(decodeWslCommandOutput(output));
  } catch (error) {
    throw formatWslCommandError(error);
  }
}
