import { spawn as spawnProcess } from 'node:child_process';

import type { WSLProcessFixture, WSLProcessRequest } from '@test/helpers/WSLProcessFixture';

export type OpencodeWSLPeerLaunch = Pick<WSLProcessRequest, 'cwd' | 'env'>;

/** OpenCode owns the native protocol peer; WSLProcessFixture owns the OS launch projection. */
export function routeOpencodeWSLPeer(native: WSLProcessFixture, cli: { command: string; peer: string }) {
  const launches: OpencodeWSLPeerLaunch[] = [];
  native.execute = request => {
    if (request.executable !== cli.command || request.argv[0] !== 'serve') return undefined;
    launches.push(request);
    return spawnProcess(process.execPath, [cli.peer, ...request.argv], {
      cwd: request.cwd, env: request.env, stdio: request.options.stdio,
    });
  };
  return launches;
}
