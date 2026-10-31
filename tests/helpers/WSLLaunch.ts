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

export function readWSLExec(spec: Pick<TargetLaunchSpec, 'args'>): { command: string; args: string[] } {
  const index = spec.args.indexOf('--exec');
  if (index < 0) throw new Error('Expected direct WSL execution');
  const [command, ...args] = spec.args.slice(index + 1).map(readWindowsToken);
  return { command, args };
}
