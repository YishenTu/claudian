import type { TargetLaunchSpec } from '@/core/process/execution-target/types';

/** Test-side CommandLineToArgvW token reader. Native WSL CI verifies the real Windows parser. */
function readWindowsToken(token: string): string {
  let result = '';
  for (let index = 0; index < token.length;) {
    let slashes = 0;
    while (token[index] === '\\') { slashes++; index++; }
    if (token[index] === '"') {
      result += '\\'.repeat(Math.floor(slashes / 2));
      if (slashes % 2) result += '"';
      index++;
    } else {
      result += '\\'.repeat(slashes);
      if (index < token.length) result += token[index++];
    }
  }
  return result;
}

/** Decodes the full Windows invocation before interpreting its WSL options. */
export function readWSLInvocation(spec: Pick<TargetLaunchSpec, 'args'>) {
  const decoded = spec.args.map(readWindowsToken);
  const index = decoded.indexOf('--exec');
  if (index < 0) throw new Error('Expected direct WSL execution');
  const [command, ...args] = decoded.slice(index + 1);
  return { command, args,
    distro: decoded[decoded.indexOf('--distribution') + 1],
    cwd: decoded[decoded.indexOf('--cd') + 1],
  };
}

export function readWSLExec(spec: Pick<TargetLaunchSpec, 'args'>): { command: string; args: string[] } {
  const { command, args } = readWSLInvocation(spec);
  return { command, args };
}
