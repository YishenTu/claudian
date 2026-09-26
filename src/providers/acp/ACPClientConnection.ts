import type { ACPJSONRPCTransport, JSONRPCRequestOptions } from './ACPJSONRPCTransport';
import {
  ACP_METHOD_NAMES,
  ACP_SERVER_NOTIFICATION_METHODS,
  ACP_SERVER_REQUEST_METHODS,
  type ACPLogicalMethod,
} from './methodNames';
import type {
  ACPAuthenticateRequest,
  ACPAuthenticateResponse,
  ACPCancelNotification,
  ACPClientCapabilities,
  ACPCreateTerminalRequest,
  ACPCreateTerminalResponse,
  ACPForkSessionRequest,
  ACPForkSessionResponse,
  ACPImplementation,
  ACPInitializeRequest,
  ACPInitializeResponse,
  ACPKillTerminalRequest,
  ACPKillTerminalResponse,
  ACPListSessionsRequest,
  ACPListSessionsResponse,
  ACPLoadSessionRequest,
  ACPLoadSessionResponse,
  ACPNewSessionRequest,
  ACPNewSessionResponse,
  ACPPromptRequest,
  ACPPromptResponse,
  ACPReadTextFileRequest,
  ACPReadTextFileResponse,
  ACPReleaseTerminalRequest,
  ACPReleaseTerminalResponse,
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
  ACPSessionNotification,
  ACPSetSessionConfigOptionRequest,
  ACPSetSessionConfigOptionResponse,
  ACPSetSessionModelRequest,
  ACPSetSessionModelResponse,
  ACPSetSessionModeRequest,
  ACPSetSessionModeResponse,
  ACPTerminalOutputRequest,
  ACPTerminalOutputResponse,
  ACPWaitForTerminalExitRequest,
  ACPWaitForTerminalExitResponse,
  ACPWriteTextFileRequest,
  ACPWriteTextFileResponse,
} from './types';

type SessionNotificationListener = (
  notification: ACPSessionNotification,
) => void | Promise<void>;

// ACP prompt turns are long-running RPCs; session/update notifications stream progress until the final response.
const ACP_PROMPT_TURN_TIMEOUT_MS = 0;

export interface ACPFileSystemDelegate {
  readTextFile?: (request: ACPReadTextFileRequest) => Promise<ACPReadTextFileResponse>;
  writeTextFile?: (request: ACPWriteTextFileRequest) => Promise<ACPWriteTextFileResponse>;
}

export interface ACPTerminalDelegate {
  createTerminal: (request: ACPCreateTerminalRequest) => Promise<ACPCreateTerminalResponse>;
  killTerminal: (request: ACPKillTerminalRequest) => Promise<ACPKillTerminalResponse>;
  releaseTerminal: (request: ACPReleaseTerminalRequest) => Promise<ACPReleaseTerminalResponse>;
  terminalOutput: (request: ACPTerminalOutputRequest) => Promise<ACPTerminalOutputResponse>;
  waitForTerminalExit: (
    request: ACPWaitForTerminalExitRequest,
  ) => Promise<ACPWaitForTerminalExitResponse>;
}

export interface ACPClientConnectionDelegate {
  fileSystem?: ACPFileSystemDelegate;
  onSessionNotification?: SessionNotificationListener;
  requestPermission?: (
    request: ACPRequestPermissionRequest,
  ) => Promise<ACPRequestPermissionResponse>;
  terminal?: ACPTerminalDelegate;
}

export interface ACPClientConnectionOptions {
  clientCapabilities?: Partial<ACPClientCapabilities>;
  clientInfo?: ACPImplementation | null;
  delegate?: ACPClientConnectionDelegate;
  transport: ACPJSONRPCTransport;
}

export class ACPClientConnection {
  private readonly sessionNotificationListeners = new Set<SessionNotificationListener>();
  private readonly unsubscribeHandlers: Array<() => void> = [];

  constructor(private readonly options: ACPClientConnectionOptions) {
    this.#registerServerHandlers();
  }

  get signal(): AbortSignal {
    return this.options.transport.signal;
  }

  onSessionNotification(listener: SessionNotificationListener): () => void {
    this.sessionNotificationListeners.add(listener);
    return () => {
      this.sessionNotificationListeners.delete(listener);
    };
  }

  dispose(): void {
    while (this.unsubscribeHandlers.length > 0) {
      this.unsubscribeHandlers.pop()?.();
    }
    this.sessionNotificationListeners.clear();
  }

  async initialize(
    partialRequest: Partial<ACPInitializeRequest> = {},
  ): Promise<ACPInitializeResponse> {
    const request: ACPInitializeRequest = {
      ...('_meta' in partialRequest ? { _meta: partialRequest._meta } : {}),
      clientCapabilities: mergeCapabilities(
        this.#buildClientCapabilities(),
        partialRequest.clientCapabilities,
      ),
      clientInfo: partialRequest.clientInfo ?? this.options.clientInfo ?? null,
      protocolVersion: partialRequest.protocolVersion ?? 1,
    };

    return this.#request<ACPInitializeResponse>('initialize', request);
  }

  authenticate(request: ACPAuthenticateRequest): Promise<ACPAuthenticateResponse> {
    return this.#request<ACPAuthenticateResponse>('authenticate', request);
  }

  newSession(request: ACPNewSessionRequest): Promise<ACPNewSessionResponse> {
    return this.#request<ACPNewSessionResponse>('newSession', request);
  }

  forkSession(request: ACPForkSessionRequest): Promise<ACPForkSessionResponse> {
    return this.#request<ACPForkSessionResponse>('forkSession', request);
  }

  loadSession(request: ACPLoadSessionRequest): Promise<ACPLoadSessionResponse> {
    return this.#request<ACPLoadSessionResponse>('loadSession', request);
  }

  listSessions(request: ACPListSessionsRequest = {}): Promise<ACPListSessionsResponse> {
    return this.#request<ACPListSessionsResponse>('listSessions', request);
  }

  prompt(request: ACPPromptRequest): Promise<ACPPromptResponse> {
    return this.#request<ACPPromptResponse>('prompt', request, {
      timeoutMs: ACP_PROMPT_TURN_TIMEOUT_MS,
    });
  }

  cancel(notification: ACPCancelNotification): void {
    this.options.transport.notify(ACP_METHOD_NAMES.cancel, notification);
  }

  setMode(request: ACPSetSessionModeRequest): Promise<ACPSetSessionModeResponse> {
    return this.#request<ACPSetSessionModeResponse>('setMode', request);
  }

  setModel(request: ACPSetSessionModelRequest): Promise<ACPSetSessionModelResponse> {
    return this.#request<ACPSetSessionModelResponse>('setModel', request);
  }

  setConfigOption(
    request: ACPSetSessionConfigOptionRequest,
  ): Promise<ACPSetSessionConfigOptionResponse> {
    return this.#request<ACPSetSessionConfigOptionResponse>('setConfigOption', request);
  }

  #buildClientCapabilities(): ACPClientCapabilities | undefined {
    const capabilities: ACPClientCapabilities = { ...this.options.clientCapabilities };
    const fileSystem = this.options.delegate?.fileSystem;
    const terminal = this.options.delegate?.terminal;

    if (fileSystem?.readTextFile || fileSystem?.writeTextFile) {
      capabilities.fs = {
        ...capabilities.fs,
        ...(fileSystem.readTextFile ? { readTextFile: true } : {}),
        ...(fileSystem.writeTextFile ? { writeTextFile: true } : {}),
      };
    }

    if (terminal) {
      capabilities.terminal = true;
    }

    return Object.keys(capabilities).length === 0 ? undefined : capabilities;
  }

  #registerServerHandlers(): void {
    const transport = this.options.transport;
    const delegate = this.options.delegate;

    const subscribeNotification = (method: string, handler: (params: unknown) => Promise<void>): void => {
      this.unsubscribeHandlers.push(transport.onNotification(method, handler));
    };
    const subscribeRequest = (method: string, handler: (params: unknown) => Promise<unknown>): void => {
      this.unsubscribeHandlers.push(transport.onRequest(method, handler));
    };

    subscribeNotification(
      ACP_SERVER_NOTIFICATION_METHODS.sessionUpdate,
      async (params) => this.#dispatchSessionNotification(params as ACPSessionNotification),
    );

    if (delegate?.requestPermission) {
      const requestPermission = delegate.requestPermission;
      subscribeRequest(
        ACP_SERVER_REQUEST_METHODS.requestPermission,
        (params) => requestPermission(params as ACPRequestPermissionRequest),
      );
    }

    const fileSystem = delegate?.fileSystem;
    if (fileSystem?.readTextFile) {
      const readTextFile = fileSystem.readTextFile;
      subscribeRequest(
        ACP_SERVER_REQUEST_METHODS.readTextFile,
        (params) => readTextFile(params as ACPReadTextFileRequest),
      );
    }
    if (fileSystem?.writeTextFile) {
      const writeTextFile = fileSystem.writeTextFile;
      subscribeRequest(
        ACP_SERVER_REQUEST_METHODS.writeTextFile,
        (params) => writeTextFile(params as ACPWriteTextFileRequest),
      );
    }

    const terminal = delegate?.terminal;
    if (terminal) {
      subscribeRequest(
        ACP_SERVER_REQUEST_METHODS.createTerminal,
        (params) => terminal.createTerminal(params as ACPCreateTerminalRequest),
      );
      subscribeRequest(
        ACP_SERVER_REQUEST_METHODS.terminalOutput,
        (params) => terminal.terminalOutput(params as ACPTerminalOutputRequest),
      );
      subscribeRequest(
        ACP_SERVER_REQUEST_METHODS.waitForTerminalExit,
        (params) => terminal.waitForTerminalExit(params as ACPWaitForTerminalExitRequest),
      );
      subscribeRequest(
        ACP_SERVER_REQUEST_METHODS.killTerminal,
        (params) => terminal.killTerminal(params as ACPKillTerminalRequest),
      );
      subscribeRequest(
        ACP_SERVER_REQUEST_METHODS.releaseTerminal,
        (params) => terminal.releaseTerminal(params as ACPReleaseTerminalRequest),
      );
    }
  }

  async #dispatchSessionNotification(notification: ACPSessionNotification): Promise<void> {
    if (this.options.delegate?.onSessionNotification) {
      await this.options.delegate.onSessionNotification(notification);
    }

    for (const listener of this.sessionNotificationListeners) {
      await listener(notification);
    }
  }

  #request<T>(
    logicalMethod: ACPLogicalMethod,
    params?: unknown,
    requestOptions?: JSONRPCRequestOptions,
  ): Promise<T> {
    return this.options.transport.request<T>(ACP_METHOD_NAMES[logicalMethod], params, requestOptions);
  }
}

function mergeCapabilities(
  base: ACPClientCapabilities | undefined,
  override: ACPClientCapabilities | undefined,
): ACPClientCapabilities | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: ACPClientCapabilities = { ...base, ...override };

  if (base?.auth || override?.auth) {
    merged.auth = { ...base?.auth, ...override?.auth };
  }
  if (base?.fs || override?.fs) {
    merged.fs = { ...base?.fs, ...override?.fs };
  }

  return Object.keys(merged).length === 0 ? undefined : merged;
}
