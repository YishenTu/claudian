import * as path from 'node:path';

import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { runProcessProbe } from '@/core/process/ProcessProbe';

import type { SessionToolRoute } from './SessionToolEndpoint';
import { SESSION_TOOL_RELAY_COMMAND } from './sessionToolRelayCommand';

export interface WSLSessionToolRelay {
  /** Linux-visible absolute Windows executable; invoke directly, without a shell. */
  readonly command: string;
  readonly args: string[];
  /** Private launch environment. Never persist or log this descriptor. */
  readonly env: Record<string, string>;
}

/**
 * MCP uses JSON-RPC lines; call mode uses one `{tool,args,callerNativeId}` line.
 * Both keep stdin open until completion. Closing stdin cancels outstanding HTTP.
 * The consumer owns its subprocess. The endpoint alone owns/revokes the route.
 */
export async function createWSLSessionToolRelay(options: {
  target: ExecutionTarget;
  hostCwd: string;
  env: Record<string, string>;
  route: SessionToolRoute;
  mode: 'mcp' | 'call';
}): Promise<WSLSessionToolRelay> {
  const { target, route, mode } = options;
  const url = new URL(route.url);
  if (target.method !== 'wsl' || !target.distroName
    || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.search || url.hash || url.pathname !== `/${mode}`) {
    throw new Error('The WSL session tool relay requires a resolved distro and an exact loopback route.');
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const command = systemRoot && createExecutionPathMapper(target).toTargetPath(
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  );
  if (!command) throw new Error('Cannot locate Windows PowerShell: SystemRoot must name the Windows installation.');
  // EncodedCommand supplies commands rather than a .ps1 file; Restricted file
  // execution policy does not require changing any machine/user policy.
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SESSION_TOOL_RELAY_COMMAND, 'utf16le').toString('base64')];
  const keys = ['CLAUDIAN_SESSION_TOOL_URL', 'CLAUDIAN_SESSION_TOOL_ROUTE', 'CLAUDIAN_SESSION_TOOL_MODE'];
  const declarations = (options.env.WSLENV ?? '').split(':').filter(entry => entry && !keys.includes(entry.split('/')[0]));
  const wslenv = [...declarations, ...keys].join(':');
  // Probe the same compiled relay, with no route credentials, across interop.
  const probe = buildTargetLaunchSpec({
    target, hostCwd: options.hostCwd, command, args,
    env: { ...options.env, WSLENV: wslenv, CLAUDIAN_SESSION_TOOL_MODE: 'probe' },
    forwardEnvironment: [{ key: 'CLAUDIAN_SESSION_TOOL_MODE' }],
  });
  const result = await runProcessProbe({ ...probe, cwd: probe.spawnCwd }, 20_000);
  if (result?.trim() !== 'claudian-relay-ready') {
    throw new Error('WSL interop could not run Windows PowerShell for session tools. Enable [interop] enabled=true in /etc/wsl.conf, restart WSL, and allow Windows PowerShell under your application policy.');
  }
  return {
    command, args,
    env: {
      WSLENV: wslenv,
      CLAUDIAN_SESSION_TOOL_URL: route.url,
      CLAUDIAN_SESSION_TOOL_ROUTE: route.routeId,
      CLAUDIAN_SESSION_TOOL_MODE: mode,
    },
  };
}
