import type { ProviderHost } from '@/core/providers/ProviderHost';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  AcpSubprocess,
} from '@/providers/acp';

import { OpencodeServerService } from '../http/OpencodeServerService';
import { assertOpencodeSessionCompatibility, detectOpencodeNativeVersion, parseOpencodeNativeVersion } from '../runtime/OpencodeVersion';

export interface OpencodeSessionForkOptions {
  serverService?: () => OpencodeServerService | undefined;
  nativeVersion?: 1 | 2;
  onNativeVersion?: (version: 1 | 2 | undefined) => void;
  cliPath: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sourceSessionId: string;
}

/** Fork immediately so subsequent source turns cannot enter the child's context. */
export async function forkOpencodeSession(options: OpencodeSessionForkOptions): Promise<string> {
  const version = await detectOpencodeNativeVersion(options.cliPath, options.environment);
  assertOpencodeSessionCompatibility(options.nativeVersion, version);
  if (version === 2) {
    const shared = options.serverService?.();
    const service = shared ?? new OpencodeServerService({ settings: {} as ProviderHost['settings'] });
    const client = await service.acquire(options.cliPath, options.cwd, options.environment);
    try {
      const child = await client.request<{ data: { id: string } }>(`/api/session/${encodeURIComponent(options.sourceSessionId)}/fork`, { method: 'POST', body: {} });
      if (typeof child.data?.id !== 'string' || !child.data.id.trim() || child.data.id === options.sourceSessionId) throw new Error('OpenCode fork returned an invalid child session.');
      options.onNativeVersion?.(2);
      return child.data.id;
    } finally { await client.dispose(); if (!shared) await service.dispose(); }
  }
  const subprocess = new AcpSubprocess({
    command: options.cliPath,
    args: ['acp'],
    cwd: options.cwd,
    env: options.environment,
  });
  let transport: AcpJsonRpcTransport | undefined;
  let connection: AcpClientConnection | undefined;
  try {
    subprocess.start();
    transport = new AcpJsonRpcTransport({
      input: subprocess.stdout,
      output: subprocess.stdin,
      onClose: listener => subprocess.onClose(listener),
    });
    // No live-output delegate: native fork replay belongs only to the new session.
    connection = new AcpClientConnection({ transport });
    transport.start();
    const initialized = await connection.initialize();
    const nativeVersion = parseOpencodeNativeVersion(initialized.agentInfo?.version);
    assertOpencodeSessionCompatibility(options.nativeVersion, nativeVersion);
    options.onNativeVersion?.(nativeVersion);
    if (!initialized.agentCapabilities?.sessionCapabilities?.fork) {
      throw new Error('This OpenCode version does not support ACP session forking. Update OpenCode to fork conversations.');
    }
    const child = await connection.forkSession({
      cwd: options.cwd,
      mcpServers: [],
      sessionId: options.sourceSessionId,
    });
    if (typeof child.sessionId !== 'string' || !child.sessionId.trim() || child.sessionId === options.sourceSessionId) {
      throw new Error('OpenCode fork returned an invalid child session.');
    }
    return child.sessionId;
  } finally {
    connection?.dispose();
    transport?.dispose();
    await subprocess.shutdown();
  }
}
