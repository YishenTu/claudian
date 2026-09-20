import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  AcpSubprocess,
} from '@/providers/acp';

export interface OpencodeSessionForkOptions {
  cliPath: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sourceSessionId: string;
}

/** Fork immediately so subsequent source turns cannot enter the child's context. */
export async function forkOpencodeSession(options: OpencodeSessionForkOptions): Promise<string> {
  const subprocess = new AcpSubprocess({
    command: options.cliPath,
    args: ['acp', `--cwd=${options.cwd}`],
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
