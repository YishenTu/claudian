import {
  ACPClientConnection,
  ACPJSONRPCTransport,
  ACPSubprocess,
} from '@/providers/acp';

import { readOpencodeHTTPMessages } from '../http/OpencodeHTTPHistory';
import { type OpencodeServerLease, type OpencodeServerService, withOpencodeServerLease } from '../http/OpencodeServerService';
import { assertOpencodeSessionCompatibility, detectOpencodeNativeVersion, parseOpencodeNativeVersion } from '../runtime/OpencodeVersion';

export interface OpencodeSessionForkOptions {
  serverService?: OpencodeServerService | null;
  nativeVersion?: 1 | 2;
  onNativeVersion?: (version: 1 | 2 | undefined) => void;
  cliPath: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sourceSessionId: string;
  resumeAt?: string;
}

/** Fork immediately so subsequent source turns cannot enter the child's context. */
export async function forkOpencodeSession(options: OpencodeSessionForkOptions): Promise<string> {
  const version = await detectOpencodeNativeVersion(options.cliPath, options.environment);
  assertOpencodeSessionCompatibility(options.nativeVersion, version);
  if (version === 2) {
    return withOpencodeServerLease(options.serverService, options.cliPath, options.cwd, options.environment, async client => {
      const child = await forkOpencodeHTTPSession(client, options.sourceSessionId, options.resumeAt);
      options.onNativeVersion?.(2);
      return child;
    });
  }
  const subprocess = new ACPSubprocess({
    command: options.cliPath,
    args: ['acp'],
    cwd: options.cwd,
    env: options.environment,
  });
  let transport: ACPJSONRPCTransport | undefined;
  let connection: ACPClientConnection | undefined;
  try {
    subprocess.start();
    transport = new ACPJSONRPCTransport({
      input: subprocess.stdout,
      output: subprocess.stdin,
      onClose: listener => subprocess.onClose(listener),
    });
    // No live-output delegate: native fork replay belongs only to the new session.
    connection = new ACPClientConnection({ transport });
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

/** Fork before the next native entry so the selected assistant reply is retained. */
export async function forkOpencodeHTTPSession(client: OpencodeServerLease, sourceSessionId: string, resumeAt?: string): Promise<string> {
  let before: string | undefined;
  if (resumeAt) {
    const messages = await readOpencodeHTTPMessages(client, sourceSessionId);
    const index = messages.findIndex(message => message.id === resumeAt && message.type === 'assistant');
    if (index === -1) throw new Error('OpenCode fork checkpoint not found. Reload the conversation and try again.');
    // The native boundary is exclusive; retain the selected assistant reply.
    const next = messages[index + 1];
    if (next) {
      if (typeof next.id !== 'string' || !next.id.trim()) throw new Error('OpenCode fork boundary has an invalid message ID.');
      before = next.id;
    }
  }
  const child = await client.request<{ data: { id: string } }>(`/api/session/${encodeURIComponent(sourceSessionId)}/fork`, { method: 'POST', body: before ? { before } : {} });
  if (typeof child.data?.id !== 'string' || !child.data.id.trim() || child.data.id === sourceSessionId) throw new Error('OpenCode fork returned an invalid child session.');
  return child.data.id;
}
