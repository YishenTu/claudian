import { chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { OpencodePeerOptions } from './OpencodeNativePeer.cjs';

export type { OpencodePeerOptions } from './OpencodeNativePeer.cjs';

const peerSource = resolve('tests/helpers/providers/opencode/OpencodeNativePeer.cjs');

/** A separate executable and scenario document per test; native processes never share live state. */
export function writeOpencodeNativePeer(cliPath: string, options: OpencodePeerOptions): string {
  copyFileSync(peerSource, cliPath);
  chmodSync(cliPath, 0o700);
  writeFileSync(cliPath + '.json', JSON.stringify(options));
  return cliPath;
}
