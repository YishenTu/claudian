import type { TargetLaunchSpec } from '@/core/process/execution-target/types';
import {
  ACPClientConnection,
  type ACPCreateElicitationRequest,
  type ACPCreateElicitationResponse,
  ACPJSONRPCTransport,
  type ACPNewSessionRequest,
  type ACPNewSessionResponse,
  type ACPPromptRequest,
  type ACPPromptResponse,
  type ACPRequestPermissionRequest,
  type ACPRequestPermissionResponse,
  type ACPResumeSessionRequest,
  type ACPResumeSessionResponse,
  type ACPSessionNotification,
  type ACPSetSessionConfigOptionRequest,
  type ACPSetSessionConfigOptionResponse,
  ACPSubprocess,
} from '@/providers/acp';

export const ANTIGRAVITY_ACP_ARGS = ['acp'] as const;

export interface AntigravityNativeConnectionOptions {
  readonly launch: TargetLaunchSpec;
  readonly version: string;
  readonly requestPermission: (request: ACPRequestPermissionRequest) => Promise<ACPRequestPermissionResponse>;
  /** Present only for sessions that answer `ask_question` forms; probes leave it unset. */
  readonly createElicitation?: (request: ACPCreateElicitationRequest) => Promise<ACPCreateElicitationResponse>;
}

/** One `agy acp` process and its ACP client. */
export class AntigravityNativeConnection {
  readonly launch: TargetLaunchSpec;
  private readonly client: ACPClientConnection;
  private readonly listeners = new Set<(notification: ACPSessionNotification) => void>();
  private readonly process: ACPSubprocess;
  private readonly transport: ACPJSONRPCTransport;
  private shutdownFlight: Promise<void> | null = null;

  constructor(options: AntigravityNativeConnectionOptions) {
    this.launch = options.launch;
    this.process = new ACPSubprocess({
      args: options.launch.args,
      command: options.launch.command,
      cwd: options.launch.spawnCwd,
      env: options.launch.env,
      windowsVerbatimArguments: options.launch.windowsVerbatimArguments,
    });
    this.process.start();
    this.transport = new ACPJSONRPCTransport({
      input: this.process.stdout,
      onClose: listener => this.process.onClose(listener),
      output: this.process.stdin,
    });
    this.client = new ACPClientConnection({
      ...(options.createElicitation ? { clientCapabilities: { elicitation: { form: {} } } } : {}),
      clientInfo: { name: 'claudian', version: options.version },
      delegate: {
        ...(options.createElicitation ? { createElicitation: options.createElicitation } : {}),
        onSessionNotification: notification => {
          for (const listener of this.listeners) listener(notification);
        },
        requestPermission: options.requestPermission,
      },
      transport: this.transport,
    });
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  newSession(request: ACPNewSessionRequest): Promise<ACPNewSessionResponse> {
    return this.client.newSession(request);
  }

  resumeSession(request: ACPResumeSessionRequest): Promise<ACPResumeSessionResponse> {
    return this.client.resumeSession(request);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.client.closeSession({ sessionId });
  }

  setConfigOption(request: ACPSetSessionConfigOptionRequest): Promise<ACPSetSessionConfigOptionResponse> {
    return this.client.setConfigOption(request);
  }

  prompt(request: ACPPromptRequest): Promise<ACPPromptResponse> {
    return this.client.prompt(request);
  }

  cancel(sessionId: string): void {
    this.client.cancel({ sessionId });
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.process.onClose(listener);
  }

  onNotification(listener: (notification: ACPSessionNotification) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  shutdown(): Promise<void> {
    this.shutdownFlight ??= (async () => {
      this.listeners.clear();
      this.client.dispose();
      this.transport.dispose();
      await this.process.shutdown();
    })();
    return this.shutdownFlight;
  }
}
