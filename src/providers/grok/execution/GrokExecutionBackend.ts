import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand } from '../../../core/types';
import type {
  AcpLoadSessionRequest,
  AcpLoadSessionResponse,
  AcpNewSessionRequest,
  AcpNewSessionResponse,
  AcpPromptRequest,
  AcpPromptResponse,
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
  AcpSessionModelState,
  AcpSessionNotification,
  AcpSetSessionModelRequest,
  AcpSetSessionModelResponse,
  AcpSetSessionModeRequest,
} from '../../acp';
import type { GrokCommandCatalog } from '../commands/GrokCommandCatalog';
import { loadGrokPromptIndexAfterAssistant } from '../history/GrokHistoryStore';
import type { GrokModelCatalogCoordinator } from '../runtime/GrokModelCatalogCoordinator';
import { GrokExecutionNativeConnectionImpl } from './GrokExecutionNativeConnection';
import { GrokExecutionSession } from './GrokExecutionSession';

export interface GrokExecutionNativeConnection {
  cancel(sessionId: string): void;
  flush?(): Promise<void>;
  fork?(request: {
    newCwd: string;
    newModelId?: string;
    sourceCwd: string;
    sourceSessionId: string;
    targetPromptIndex: number;
  }): Promise<{
    newCwd: string;
    newSessionId: string;
    parentSessionId: string;
  }>;
  initialize(): Promise<void>;
  isAlive?(): boolean;
  interject?(request: {
    content: AcpPromptRequest['prompt'];
    interjectionId: string;
    sessionId: string;
    text: string;
  }, signal?: AbortSignal): Promise<void>;
  loadSession(request: AcpLoadSessionRequest): Promise<AcpLoadSessionResponse>;
  listCommands(cwd: string, signal?: AbortSignal): Promise<SlashCommand[]>;
  newSession(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse>;
  onNotification(
    listener: (
      notification: AcpSessionNotification,
      source: 'extension' | 'standard',
    ) => void,
  ): () => void;
  onModeChanged?(listener: (mode: 'normal' | 'yolo') => void): () => void;
  onModelsChanged?(listener: (models: AcpSessionModelState) => void): () => void;
  prompt(request: AcpPromptRequest): Promise<AcpPromptResponse>;
  rewind?(request: {
    force: boolean;
    mode: 'all' | 'conversation_only' | 'files_only';
    sessionId: string;
    targetPromptIndex: number;
  }): Promise<{
    cleanFiles: string[];
    conflicts: Array<{ conflictType: string; path: string }>;
    error: string | null;
    revertedFiles: string[];
    success: boolean;
  }>;
  setMode(request: AcpSetSessionModeRequest): Promise<unknown>;
  setModel(request: AcpSetSessionModelRequest): Promise<AcpSetSessionModelResponse>;
  shutdown(): Promise<void>;
}

export interface GrokExecutionNativeCreateOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requestPermission: (
    request: AcpRequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<AcpRequestPermissionResponse>;
  readonly requestExtension: (
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  readonly version: string;
}

export interface GrokExecutionNativeFactory {
  create(options: GrokExecutionNativeCreateOptions): GrokExecutionNativeConnection;
}

export interface GrokExecutionBackendOptions {
  readonly commandCatalog?: Pick<GrokCommandCatalog, 'setCommandSnapshot'>;
  readonly modelCatalogCoordinator?: Pick<GrokModelCatalogCoordinator, 'mergeLiveModels'>;
  readonly nativeFactory?: GrokExecutionNativeFactory;
  readonly resolvePromptIndex?: (
    sessionDirectory: string,
    providerSessionId: string,
    assistantMessageId: string,
  ) => Promise<number | null>;
}

export class GrokExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'grok' as const;
  private readonly nativeFactory: GrokExecutionNativeFactory;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: GrokExecutionBackendOptions = {},
  ) {
    this.nativeFactory = options.nativeFactory ?? {
      create: nativeOptions => new GrokExecutionNativeConnectionImpl(nativeOptions),
    };
  }

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new GrokExecutionSession(this.plugin, config, {
      commandCatalog: this.options.commandCatalog,
      modelCatalogCoordinator: this.options.modelCatalogCoordinator,
      nativeFactory: this.nativeFactory,
      resolvePromptIndex: this.options.resolvePromptIndex
        ?? ((directory, providerSessionId, assistantId) => loadGrokPromptIndexAfterAssistant(
          directory,
          providerSessionId,
          assistantId,
        )),
    });
  }
}
