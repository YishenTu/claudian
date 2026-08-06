import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { t } from '@/i18n/i18n';
import {
  AcpClientConnection,
  AcpInteractionController,
  AcpJsonRpcTransport,
  type AcpPermissionPresentation,
  type AcpPromptRequest,
  type AcpPromptResponse,
  type AcpReadTextFileRequest,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionNotification,
  AcpSubprocess,
  type AcpWriteTextFileRequest,
} from '@/providers/acp';

import { buildCursorLaunchSpec } from '../runtime/CursorLaunchSpec';
import { CursorExtensionInteractionRouter } from './CursorExtensionInteractionRouter';

export interface CursorAcpSessionKernelOptions {
  readonly config: ProviderSessionConfig;
  readonly getActiveTurnId: () => string | null;
  readonly onClosed: (error: Error) => void;
  readonly onNotification: (notification: AcpSessionNotification) => void;
  readonly plugin: ProviderHost;
  readonly sessionInstanceId: string;
}

export interface CursorNativeSessionInfo {
  readonly configOptions?: AcpSessionConfigOption[] | null;
  readonly models?: AcpSessionModelState | null;
  readonly sessionId: string;
}

export interface CursorAcpSessionKernel {
  connect(): Promise<void>;
  openSession(resumeSessionId?: string): Promise<CursorNativeSessionInfo>;
  setModel(request: { modelId: string; sessionId: string }): Promise<void>;
  setMode(request: { modeId: string; sessionId: string }): Promise<void>;
  setConfigOption(request: {
    configId: string;
    sessionId: string;
    type: 'select';
    value: string;
  }): Promise<void>;
  prompt(request: AcpPromptRequest): Promise<Pick<AcpPromptResponse, 'usage' | 'userMessageId'>>;
  cancel(sessionId: string): void;
  dispose(): Promise<void>;
}

export class DefaultCursorAcpSessionKernel implements CursorAcpSessionKernel {
  private connection: AcpClientConnection | null = null;
  private process: AcpSubprocess | null = null;
  private transport: AcpJsonRpcTransport | null = null;
  private interaction: AcpInteractionController | null = null;
  private extensionInteraction: CursorExtensionInteractionRouter | null = null;
  private extensionUnsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly options: CursorAcpSessionKernelOptions) {}

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('Cursor ACP kernel is disposed');
    if (this.connection) return;

    const command = await this.options.plugin.getResolvedProviderCliPath('cursor') ?? 'agent';
    const spec = buildCursorLaunchSpec({
      command,
      cwd: this.options.config.vaultWorkingDirectory,
      env: { ...process.env },
    });
    const subprocess = new AcpSubprocess(spec);
    subprocess.onClose((error) => {
      if (!this.disposed) this.options.onClosed(error ?? new Error('Cursor ACP process closed'));
    });
    subprocess.start();
    this.process = subprocess;
    const transport = new AcpJsonRpcTransport({
      input: subprocess.stdout,
      onClose: (listener) => subprocess.onClose(listener),
      output: subprocess.stdin,
    });
    this.transport = transport;
    this.extensionInteraction = new CursorExtensionInteractionRouter(
      this.options.config.interactionPort,
      this.options.sessionInstanceId,
      this.options.getActiveTurnId,
    );
    for (const method of ['cursor/ask_question', 'cursor/create_plan']) {
      this.extensionUnsubscribers.push(transport.onRequest(
        method,
        params => this.extensionInteraction?.handle(method, params),
      ));
    }
    this.interaction = new AcpInteractionController({
      getTurnId: this.options.getActiveTurnId,
      interactionPort: this.options.config.interactionPort,
      presentPermission: presentCursorPermission,
      sessionInstanceId: this.options.sessionInstanceId,
    });
    const connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian',
        version: this.options.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        fileSystem: {
          readTextFile: request => this.readTextFile(request),
          writeTextFile: request => this.writeTextFile(request),
        },
        onSessionNotification: notification => this.options.onNotification(notification),
        requestPermission: request => this.requestPermission(request),
      },
      transport,
    });
    this.connection = connection;
    transport.start();
    await connection.initialize();
  }

  async openSession(resumeSessionId?: string): Promise<CursorNativeSessionInfo> {
    if (!this.connection) throw new Error('Cursor ACP kernel is not connected');
    const request = {
      cwd: this.options.config.vaultWorkingDirectory,
      mcpServers: [],
    };
    if (resumeSessionId) {
      const response = await this.connection.loadSession({ ...request, sessionId: resumeSessionId });
      return {
        configOptions: response.configOptions,
        models: response.models,
        sessionId: response.sessionId ?? resumeSessionId,
      };
    }
    const response = await this.connection.newSession(request);
    return {
      configOptions: response.configOptions,
      models: response.models,
      sessionId: response.sessionId,
    };
  }

  async setModel(request: { modelId: string; sessionId: string }): Promise<void> {
    if (!this.connection) throw new Error('Cursor ACP kernel is not connected');
    await this.connection.setModel(request);
  }

  async setMode(request: { modeId: string; sessionId: string }): Promise<void> {
    if (!this.connection) throw new Error('Cursor ACP kernel is not connected');
    await this.connection.setMode(request);
  }

  async setConfigOption(request: {
    configId: string;
    sessionId: string;
    type: 'select';
    value: string;
  }): Promise<void> {
    if (!this.connection) throw new Error('Cursor ACP kernel is not connected');
    await this.connection.setConfigOption(request);
  }

  prompt(request: AcpPromptRequest): Promise<Pick<AcpPromptResponse, 'usage' | 'userMessageId'>> {
    if (!this.connection) throw new Error('Cursor ACP kernel is not connected');
    return this.connection.prompt(request);
  }

  cancel(sessionId: string): void {
    this.connection?.cancel({ sessionId });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.interaction?.dispose();
    this.extensionInteraction?.dispose();
    for (const unsubscribe of this.extensionUnsubscribers.splice(0)) unsubscribe();
    this.connection?.dispose();
    this.transport?.dispose();
    await this.process?.shutdown();
    this.connection = null;
    this.transport = null;
    this.process = null;
    this.extensionInteraction = null;
  }

  private async readTextFile(request: AcpReadTextFileRequest): Promise<{ content: string }> {
    const filePath = resolveWorkspacePath(this.options.config.vaultWorkingDirectory, request.path);
    const content = await fs.readFile(filePath, 'utf8');
    if (request.line === undefined && request.limit === undefined) return { content };
    const lines = content.split(/\r?\n/u);
    const start = Math.max(0, (request.line ?? 1) - 1);
    const end = request.limit == null ? lines.length : start + Math.max(0, request.limit);
    return { content: lines.slice(start, end).join('\n') };
  }

  private async writeTextFile(request: AcpWriteTextFileRequest): Promise<Record<string, never>> {
    const filePath = resolveWorkspacePath(this.options.config.vaultWorkingDirectory, request.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, request.content, 'utf8');
    return {};
  }

  private requestPermission(request: AcpRequestPermissionRequest): Promise<AcpRequestPermissionResponse> {
    return this.interaction?.requestPermission(request)
      ?? Promise.resolve({ outcome: { outcome: 'cancelled' } });
  }
}

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Cursor file access is limited to the current workspace');
  }
  return resolved;
}

function presentCursorPermission(
  request: AcpRequestPermissionRequest,
  _input: Readonly<Record<string, unknown>>,
): AcpPermissionPresentation {
  return {
    description: t('settings.cursor.permissionRequest', {
      tool: request.toolCall.title || t('settings.cursor.tool'),
    }),
    toolName: request.toolCall.title || t('settings.cursor.tool'),
  };
}
