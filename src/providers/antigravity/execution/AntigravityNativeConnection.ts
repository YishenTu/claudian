import type { TargetLaunchSpec } from '@/core/process/execution-target/types';
import {
  type ACPClientConnection,
  type ACPCreateElicitationRequest,
  type ACPCreateElicitationResponse,
  ACPNativeProcess,
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
  private readonly listeners = new Set<(notification: ACPSessionNotification) => void>();
  private readonly native: ACPNativeProcess;

  constructor(options: AntigravityNativeConnectionOptions) {
    this.launch = options.launch;
    this.native = new ACPNativeProcess({
      launch: {
        args: options.launch.args,
        command: options.launch.command,
        cwd: options.launch.spawnCwd,
        env: options.launch.env,
        windowsVerbatimArguments: options.launch.windowsVerbatimArguments,
      },
      version: options.version,
      ...(options.createElicitation ? { clientCapabilities: { elicitation: { form: {} } } } : {}),
      delegate: {
        ...(options.createElicitation ? { createElicitation: options.createElicitation } : {}),
        onSessionNotification: notification => {
          for (const listener of this.listeners) listener(notification);
        },
        requestPermission: options.requestPermission,
      },
    });
  }

  private get client(): ACPClientConnection {
    return this.native.client;
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
    return this.native.flush();
  }

  isAlive(): boolean {
    return this.native.isAlive();
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.native.onClose(listener);
  }

  onNotification(listener: (notification: ACPSessionNotification) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  shutdown(): Promise<void> {
    return this.native.shutdown(() => this.listeners.clear());
  }
}
