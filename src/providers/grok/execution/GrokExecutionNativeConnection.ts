import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  AcpSubprocess,
  normalizeAcpAvailableCommands,
} from '../../acp';
import {
  requestGrokInterjection,
  requestGrokRewind,
  requestGrokSessionFork,
} from '../runtime/GrokExtensionRequests';
import {
  GROK_SESSION_UPDATE_NOTIFICATION_METHODS,
  GROK_WRAPPED_SESSION_NOTIFICATION_METHOD,
  parseGrokSessionNotification,
} from '../runtime/GrokSessionNotifications';
import type {
  GrokExecutionNativeConnection,
  GrokExecutionNativeCreateOptions,
} from './GrokExecutionBackend';

const GROK_EXTENSION_REQUEST_METHODS = [
  'x.ai/ask_user_question',
  '_x.ai/ask_user_question',
  'x.ai/exit_plan_mode',
  '_x.ai/exit_plan_mode',
] as const;

const GROK_EXTENSION_NOTIFICATION_METHODS = [
  'x.ai/yolo_mode_changed',
  '_x.ai/yolo_mode_changed',
] as const;

export class GrokExecutionNativeConnectionImpl
implements GrokExecutionNativeConnection {
  private readonly connection: AcpClientConnection;
  private readonly listeners = new Set<Parameters<GrokExecutionNativeConnection['onNotification']>[0]>();
  private readonly modeListeners = new Set<(mode: 'normal' | 'yolo') => void>();
  private readonly process: AcpSubprocess;
  private readonly transport: AcpJsonRpcTransport;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: GrokExecutionNativeCreateOptions) {
    this.process = new AcpSubprocess({
      args: ['agent', '--no-leader', 'stdio'],
      command: options.command,
      cwd: options.cwd,
      env: options.env,
    });
    this.process.start();
    this.transport = new AcpJsonRpcTransport({
      input: this.process.stdout,
      onClose: listener => this.process.onClose(listener),
      output: this.process.stdin,
    });
    this.connection = new AcpClientConnection({
      clientInfo: { name: 'claudian', version: options.version },
      delegate: {
        onSessionNotification: notification => this.notify(notification, 'standard'),
        requestPermission: request => options.requestPermission(request),
      },
      methodOverrides: { cancel: 'session/cancel' },
      transport: this.transport,
    });
    for (const method of [
      ...GROK_SESSION_UPDATE_NOTIFICATION_METHODS,
      GROK_WRAPPED_SESSION_NOTIFICATION_METHOD,
    ]) {
      this.unsubscribers.push(this.transport.onNotification(method, params => {
        const notification = parseGrokSessionNotification(method, params);
        if (notification) this.notify(notification, 'extension');
      }));
    }
    for (const method of GROK_EXTENSION_REQUEST_METHODS) {
      this.unsubscribers.push(this.transport.onRequest(
        method,
        params => options.requestExtension(method, params),
      ));
    }
    for (const method of GROK_EXTENSION_NOTIFICATION_METHODS) {
      this.unsubscribers.push(this.transport.onNotification(method, params => {
        if (!isRecord(params) || typeof params.yolo_mode !== 'boolean') return;
        const mode = params.yolo_mode ? 'yolo' : 'normal';
        for (const listener of this.modeListeners) listener(mode);
      }));
    }
  }

  cancel(sessionId: string): void {
    this.connection.cancel({ sessionId });
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  fork: NonNullable<GrokExecutionNativeConnection['fork']> = request => (
    requestGrokSessionFork(this.transport, request)
  );

  async initialize(): Promise<void> {
    await this.connection.initialize();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  interject(
    request: Parameters<typeof requestGrokInterjection>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    return requestGrokInterjection(this.transport, request, signal);
  }

  loadSession: GrokExecutionNativeConnection['loadSession'] = request => (
    this.connection.loadSession(request)
  );

  async listCommands(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<GrokExecutionNativeConnection['listCommands']>>> {
    const response = await this.transport.request<{ commands?: unknown }>(
      '_x.ai/commands/list',
      { cwd },
      { signal, timeoutMs: 5_000 },
    );
    if (!Array.isArray(response.commands)) {
      throw new Error('Grok returned malformed command metadata.');
    }
    return normalizeAcpAvailableCommands(response.commands);
  }

  newSession: GrokExecutionNativeConnection['newSession'] = request => (
    this.connection.newSession(request)
  );

  onNotification(
    listener: Parameters<GrokExecutionNativeConnection['onNotification']>[0],
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onModeChanged(listener: (mode: 'normal' | 'yolo') => void): () => void {
    this.modeListeners.add(listener);
    return () => this.modeListeners.delete(listener);
  }

  prompt: GrokExecutionNativeConnection['prompt'] = request => (
    this.connection.prompt(request)
  );

  rewind: NonNullable<GrokExecutionNativeConnection['rewind']> = request => (
    requestGrokRewind(this.transport, request)
  );

  setMode: GrokExecutionNativeConnection['setMode'] = request => (
    this.connection.setMode(request)
  );

  setModel: GrokExecutionNativeConnection['setModel'] = request => (
    this.connection.setModel(request)
  );

  async shutdown(): Promise<void> {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.listeners.clear();
    this.modeListeners.clear();
    this.connection.dispose();
    this.transport.dispose();
    await this.process.shutdown();
  }

  private notify(
    notification: Parameters<Parameters<GrokExecutionNativeConnection['onNotification']>[0]>[0],
    source: 'extension' | 'standard',
  ): void {
    for (const listener of this.listeners) listener(notification, source);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
