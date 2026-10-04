import { promises as fs } from 'fs';
import * as path from 'path';

import {
  mapACPApprovalDecision,
} from '@/providers/acp/ACPPermissionAdapter';
import { ACPClientConnection } from '@/providers/acp/ACPClientConnection';
import { ACPInteractionController } from '@/providers/acp/ACPInteractionController';
import { ACPJSONRPCTransport } from '@/providers/acp/ACPJSONRPCTransport';
import { ACPSubprocess } from '@/providers/acp/ACPSubprocess';
import type {
  ACPPromptRequest,
  ACPPromptResponse,
  ACPReadTextFileRequest,
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
  ACPWriteTextFileRequest,
} from '@/providers/acp/types';

import { AntigravityBinaryResolver } from '../runtime/AntigravityBinaryResolver';
import { getAntigravityRuntimeEnvironment } from '../runtime/AntigravityRuntimeEnvironment';
import { getAntigravityProviderSettings } from '../settings';
import type {
  AntigravityNativeSessionInfo,
  AntigravitySessionKernel,
  AntigravitySessionKernelOptions,
} from './AntigravitySessionContract';

export class AntigravityACPSessionKernel implements AntigravitySessionKernel {
  private connection: ACPClientConnection | null = null;
  private transport: ACPJSONRPCTransport | null = null;
  private process: ACPSubprocess | null = null;
  private interactionController: ACPInteractionController | null = null;
  private disposed = false;
  private connectPromise: Promise<void> | null = null;
  private permissionMode: string = 'default';

  constructor(
    private readonly options: AntigravitySessionKernelOptions,
    private readonly binaryResolver: AntigravityBinaryResolver = new AntigravityBinaryResolver(),
  ) {}

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error('Antigravity ACP kernel is disposed');
    }
    if (this.connection) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const pending = this.#performConnect();
    this.connectPromise = pending;
    try {
      await pending;
    } finally {
      if (this.connectPromise === pending) {
        this.connectPromise = null;
      }
    }
  }

  async #performConnect(): Promise<void> {
    try {
      const settings = this.options.plugin.settings as Record<string, unknown>;
      const providerSettings = getAntigravityProviderSettings(settings);
      this.permissionMode = providerSettings.permissionMode;

      const cliPath = this.binaryResolver.resolveFromSettings(settings);
      if (!cliPath) {
        throw new Error(
          'Google Antigravity server binary (agy_acp_server) was not found. ' +
          'Please set the path in Settings > Providers > Antigravity.',
        );
      }

      const rawArgs = providerSettings.serverArguments?.trim();
      let args: string[] = [];
      if (rawArgs) {
        args = rawArgs.split(/\s+/).filter(Boolean);
      } else if (process.platform === 'linux') {
        args = ['--uid='];
      }

      const processEnv = getAntigravityRuntimeEnvironment(settings, cliPath);

      const subprocess = new ACPSubprocess({
        args,
        command: cliPath,
        cwd: this.options.config.vaultWorkingDirectory,
        env: processEnv,
      });
      this.process = subprocess;
      this.#assertNotDisposed();

      subprocess.start();
      this.#assertNotDisposed();

      const transport = new ACPJSONRPCTransport({
        input: subprocess.stdout,
        onClose: (listener) => subprocess.onClose(listener),
        output: subprocess.stdin,
      });
      this.transport = transport;
      this.#assertNotDisposed();

      transport.onClose((error) => {
        if (!this.disposed && this.transport === transport) {
          this.options.onClosed(
            error ?? new Error('Antigravity ACP transport closed'),
          );
        }
      });

      this.interactionController = new ACPInteractionController({
        getTurnId: this.options.getActiveTurnId,
        interactionPort: this.options.config.interactionPort,
        presentPermission: (request) => ({
          description: request.toolCall.title || 'Antigravity tool request',
          toolName: request.toolCall.title || request.toolCall.kind || 'tool',
        }),
        sessionInstanceId: this.options.sessionInstanceId,
      });
      this.#assertNotDisposed();

      const connection = new ACPClientConnection({
        clientInfo: {
          name: 'claudian',
          version: this.options.plugin.manifest?.version ?? '1.0.0',
        },
        delegate: {
          fileSystem: this.#createFileSystemDelegate(),
          onSessionNotification: (notification) => {
            if (!this.disposed) this.options.onNotification(notification);
          },
          requestPermission: (request) => this.#handlePermissionRequest(request),
        },
        transport,
      });
      this.connection = connection;
      this.#assertNotDisposed();

      transport.start();
      this.#assertNotDisposed();

      await connection.initialize({
        protocolVersion: 1,
        clientInfo: {
          name: 'obsidian-antigravity',
          version: this.options.plugin.manifest?.version ?? '1.0.0',
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      });
      this.#assertNotDisposed();

      // Authenticate
      const authMethod = providerSettings.authMethod || 'oauth-personal';
      await connection.authenticate({
        methodId: authMethod,
      });
      this.#assertNotDisposed();
    } catch (error) {
      await this.#disposeNativeResources();
      throw error;
    }
  }

  async openSession(resumeSessionId?: string): Promise<AntigravityNativeSessionInfo> {
    const connection = this.#requireConnection();
    const cwd = this.options.config.vaultWorkingDirectory;

    if (resumeSessionId) {
      try {
        const response = await connection.loadSession({
          cwd,
          mcpServers: [],
          sessionId: resumeSessionId,
        });
        return {
          sessionId: response.sessionId || resumeSessionId,
          configOptions: response.configOptions,
          models: response.models,
        };
      } catch {
        // Fallback to new session if loadSession fails
      }
    }

    const response = await connection.newSession({
      cwd,
      mcpServers: [],
    });

    return {
      sessionId: response.sessionId,
      configOptions: response.configOptions,
      models: response.models,
      currentModeId: response.modes?.currentModeId,
    };
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const connection = this.#requireConnection();
    await connection.setConfigOption({
      configId,
      sessionId: this.options.sessionInstanceId,
      type: 'select',
      value,
    });
  }

  async setModel(modelId: string): Promise<void> {
    const connection = this.#requireConnection();
    await connection.setModel({
      modelId,
      sessionId: this.options.sessionInstanceId,
    });
  }

  async setMode(modeId: string): Promise<void> {
    this.permissionMode = modeId;
    const connection = this.#requireConnection();
    await connection.setMode({
      modeId,
      sessionId: this.options.sessionInstanceId,
    });
  }

  async prompt(request: ACPPromptRequest): Promise<Pick<
    ACPPromptResponse,
    'usage' | 'userMessageId'
  > & Partial<Pick<ACPPromptResponse, 'stopReason'>>> {
    const connection = this.#requireConnection();
    return connection.prompt(request);
  }

  cancel(sessionId: string): void {
    if (this.disposed || !this.connection) return;
    this.connection.cancel({ sessionId });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.#disposeNativeResources();
  }

  async #disposeNativeResources(): Promise<void> {
    this.interactionController?.dispose();
    this.interactionController = null;

    if (this.transport) {
      try {
        await this.transport.dispose();
      } catch {
        // ignore
      }
      this.transport = null;
    }

    if (this.process) {
      try {
        await this.process.shutdown();
      } catch {
        // ignore
      }
      this.process = null;
    }

    this.connection = null;
  }

  #assertNotDisposed(): void {
    if (this.disposed) throw new Error('Antigravity ACP kernel is disposed');
  }

  #requireConnection(): ACPClientConnection {
    if (!this.connection) {
      throw new Error('Antigravity ACP kernel is not connected');
    }
    return this.connection;
  }

  #createFileSystemDelegate(): {
    readTextFile: (request: ACPReadTextFileRequest) => Promise<{ content: string }>;
    writeTextFile: (request: ACPWriteTextFileRequest) => Promise<Record<string, never>>;
  } {
    return {
      readTextFile: async (request: ACPReadTextFileRequest): Promise<{ content: string }> => {
        const resolvedPath = path.isAbsolute(request.path)
          ? path.resolve(request.path)
          : path.resolve(this.options.config.vaultWorkingDirectory, request.path);
        const content = await fs.readFile(resolvedPath, 'utf8');
        if (request.line === undefined && request.limit === undefined) {
          return { content };
        }
        const lines = content.split(/\r?\n/);
        const start = Math.max(0, (request.line ?? 1) - 1);
        const limit = request.limit;
        const end = limit === undefined || limit === null
          ? lines.length
          : start + Math.max(0, limit);
        return { content: lines.slice(start, end).join('\n') };
      },
      writeTextFile: async (request: ACPWriteTextFileRequest): Promise<Record<string, never>> => {
        const resolvedPath = path.isAbsolute(request.path)
          ? path.resolve(request.path)
          : path.resolve(this.options.config.vaultWorkingDirectory, request.path);
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, request.content, 'utf8');
        return {};
      },
    };
  }

  #handlePermissionRequest(
    request: ACPRequestPermissionRequest,
  ): Promise<ACPRequestPermissionResponse> {
    if (this.disposed) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    if (this.permissionMode === 'yolo') {
      return Promise.resolve(mapACPApprovalDecision('allow', request.options));
    }
    if (this.permissionMode === 'auto_edit') {
      const toolName = (request.toolCall.title || request.toolCall.kind || '').toLowerCase();
      if (toolName.includes('write') || toolName.includes('edit') || toolName.includes('patch')) {
        return Promise.resolve(mapACPApprovalDecision('allow', request.options));
      }
    }
    return this.interactionController?.requestPermission(request)
      ?? Promise.resolve({ outcome: { outcome: 'cancelled' } });
  }
}
