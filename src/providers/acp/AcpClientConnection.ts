import type { AcpJsonRpcTransport, JsonRpcRequestOptions } from './AcpJsonRpcTransport';
import { JsonRpcErrorResponse } from './AcpJsonRpcTransport';
import {
  ACP_SERVER_NOTIFICATION_ALIASES,
  ACP_SERVER_REQUEST_ALIASES,
  type AcpLogicalMethod,
  type AcpMethodOverrides,
  getAcpMethodCandidates,
} from './methodNames';
import type {
  AcpAuthenticateRequest,
  AcpAuthenticateResponse,
  AcpCancelNotification,
  AcpClientCapabilities,
  AcpCreateTerminalRequest,
  AcpCreateTerminalResponse,
  AcpImplementation,
  AcpInitializeRequest,
  AcpInitializeResponse,
  AcpKillTerminalRequest,
  AcpKillTerminalResponse,
  AcpListSessionsRequest,
  AcpListSessionsResponse,
  AcpLoadSessionRequest,
  AcpLoadSessionResponse,
  AcpNewSessionRequest,
  AcpNewSessionResponse,
  AcpPromptRequest,
  AcpPromptResponse,
  AcpReadTextFileRequest,
  AcpReadTextFileResponse,
  AcpReleaseTerminalRequest,
  AcpReleaseTerminalResponse,
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
  AcpSessionNotification,
  AcpSetSessionConfigOptionRequest,
  AcpSetSessionConfigOptionResponse,
  AcpSetSessionModeRequest,
  AcpSetSessionModeResponse,
  AcpTerminalOutputRequest,
  AcpTerminalOutputResponse,
  AcpWaitForTerminalExitRequest,
  AcpWaitForTerminalExitResponse,
  AcpWriteTextFileRequest,
  AcpWriteTextFileResponse,
} from './types';

type SessionNotificationListener = (
  notification: AcpSessionNotification,
) => void | Promise<void>;

// ACP prompt turns are long-running RPCs; session/update notifications stream progress until the final response.
const ACP_PROMPT_TURN_TIMEOUT_MS = 0;

export interface AcpFileSystemDelegate {
  readTextFile?: (request: AcpReadTextFileRequest) => Promise<AcpReadTextFileResponse>;
  writeTextFile?: (request: AcpWriteTextFileRequest) => Promise<AcpWriteTextFileResponse>;
}

export interface AcpTerminalDelegate {
  createTerminal: (request: AcpCreateTerminalRequest) => Promise<AcpCreateTerminalResponse>;
  killTerminal: (request: AcpKillTerminalRequest) => Promise<AcpKillTerminalResponse>;
  releaseTerminal: (request: AcpReleaseTerminalRequest) => Promise<AcpReleaseTerminalResponse>;
  terminalOutput: (request: AcpTerminalOutputRequest) => Promise<AcpTerminalOutputResponse>;
  waitForTerminalExit: (
    request: AcpWaitForTerminalExitRequest,
  ) => Promise<AcpWaitForTerminalExitResponse>;
}

export interface AcpClientConnectionDelegate {
  fileSystem?: AcpFileSystemDelegate;
  onSessionNotification?: SessionNotificationListener;
  requestPermission?: (
    request: AcpRequestPermissionRequest,
  ) => Promise<AcpRequestPermissionResponse>;
  terminal?: AcpTerminalDelegate;
}

export interface AcpClientConnectionOptions {
  clientCapabilities?: Partial<AcpClientCapabilities>;
  clientInfo?: AcpImplementation | null;
  delegate?: AcpClientConnectionDelegate;
  methodOverrides?: AcpMethodOverrides;
  transport: AcpJsonRpcTransport;
}

export class AcpClientConnection {
  private agentInfo: AcpInitializeResponse['agentInfo'] | null = null;
  private agentCapabilities: AcpInitializeResponse['agentCapabilities'] | null = null;
  private authMethods: AcpInitializeResponse['authMethods'] | null = null;
  private readonly methodCache = new Map<AcpLogicalMethod, string>();
  private readonly sessionNotificationListeners = new Set<SessionNotificationListener>();
  private readonly unsubscribeHandlers: Array<() => void> = [];

  constructor(private readonly options: AcpClientConnectionOptions) {
    this.registerServerHandlers();
  }

  get signal(): AbortSignal {
    return this.options.transport.signal;
  }

  get negotiatedAgentInfo(): AcpInitializeResponse['agentInfo'] | null {
    return this.agentInfo;
  }

  get negotiatedAgentCapabilities(): AcpInitializeResponse['agentCapabilities'] | null {
    return this.agentCapabilities;
  }

  get negotiatedAuthMethods(): AcpInitializeResponse['authMethods'] | null {
    return this.authMethods;
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
    partialRequest: Partial<AcpInitializeRequest> = {},
  ): Promise<AcpInitializeResponse> {
    const request: AcpInitializeRequest = {
      clientCapabilities: mergeCapabilities(
        this.buildClientCapabilities(),
        partialRequest.clientCapabilities,
      ),
      clientInfo: partialRequest.clientInfo ?? this.options.clientInfo ?? null,
      protocolVersion: partialRequest.protocolVersion ?? 1,
    };

    const response = await this.requestWithFallback<AcpInitializeResponse>('initialize', request);
    this.agentInfo = response.agentInfo ?? null;
    this.agentCapabilities = response.agentCapabilities ?? null;
    this.authMethods = response.authMethods ?? null;
    return response;
  }

  authenticate(request: AcpAuthenticateRequest): Promise<AcpAuthenticateResponse> {
    return this.requestWithFallback<AcpAuthenticateResponse>('authenticate', request);
  }

  newSession(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse> {
    return this.requestWithFallback<AcpNewSessionResponse>('newSession', request);
  }

  loadSession(request: AcpLoadSessionRequest): Promise<AcpLoadSessionResponse> {
    return this.requestWithFallback<AcpLoadSessionResponse>('loadSession', request);
  }

  listSessions(request: AcpListSessionsRequest = {}): Promise<AcpListSessionsResponse> {
    return this.requestWithFallback<AcpListSessionsResponse>('listSessions', request);
  }

  prompt(request: AcpPromptRequest): Promise<AcpPromptResponse> {
    return this.requestWithFallback<AcpPromptResponse>('prompt', request, {
      timeoutMs: ACP_PROMPT_TURN_TIMEOUT_MS,
    });
  }

  cancel(notification: AcpCancelNotification): void {
    this.notifyLogicalMethod('cancel', notification, { sendAllCandidatesIfUncached: true });
  }

  setMode(request: AcpSetSessionModeRequest): Promise<AcpSetSessionModeResponse> {
    return this.requestWithFallback<AcpSetSessionModeResponse>('setMode', request);
  }

  setConfigOption(
    request: AcpSetSessionConfigOptionRequest,
  ): Promise<AcpSetSessionConfigOptionResponse> {
    return this.requestWithFallback<AcpSetSessionConfigOptionResponse>('setConfigOption', request);
  }

  private buildClientCapabilities(): AcpClientCapabilities | undefined {
    const capabilities: AcpClientCapabilities = { ...this.options.clientCapabilities };
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

  private registerServerHandlers(): void {
    const transport = this.options.transport;
    const delegate = this.options.delegate;

    const subscribeNotification = (aliases: readonly string[], handler: (params: unknown) => Promise<void>): void => {
      for (const alias of aliases) {
        this.unsubscribeHandlers.push(transport.onNotification(alias, handler));
      }
    };
    const subscribeRequest = (aliases: readonly string[], handler: (params: unknown) => Promise<unknown>): void => {
      for (const alias of aliases) {
        this.unsubscribeHandlers.push(transport.onRequest(alias, handler));
      }
    };

    subscribeNotification(
      ACP_SERVER_NOTIFICATION_ALIASES.sessionUpdate,
      async (params) => this.dispatchSessionNotification(params as AcpSessionNotification),
    );

    if (delegate?.requestPermission) {
      const requestPermission = delegate.requestPermission;
      subscribeRequest(
        ACP_SERVER_REQUEST_ALIASES.requestPermission,
        (params) => requestPermission(params as AcpRequestPermissionRequest),
      );
    }

    const fileSystem = delegate?.fileSystem;
    if (fileSystem?.readTextFile) {
      const readTextFile = fileSystem.readTextFile;
      subscribeRequest(
        ACP_SERVER_REQUEST_ALIASES.readTextFile,
        (params) => readTextFile(params as AcpReadTextFileRequest),
      );
    }
    if (fileSystem?.writeTextFile) {
      const writeTextFile = fileSystem.writeTextFile;
      subscribeRequest(
        ACP_SERVER_REQUEST_ALIASES.writeTextFile,
        (params) => writeTextFile(params as AcpWriteTextFileRequest),
      );
    }

    const terminal = delegate?.terminal;
    if (terminal) {
      subscribeRequest(
        ACP_SERVER_REQUEST_ALIASES.createTerminal,
        (params) => terminal.createTerminal(params as AcpCreateTerminalRequest),
      );
      subscribeRequest(
        ACP_SERVER_REQUEST_ALIASES.terminalOutput,
        (params) => terminal.terminalOutput(params as AcpTerminalOutputRequest),
      );
      subscribeRequest(
        ACP_SERVER_REQUEST_ALIASES.waitForTerminalExit,
        (params) => terminal.waitForTerminalExit(params as AcpWaitForTerminalExitRequest),
      );
      subscribeRequest(
        ACP_SERVER_REQUEST_ALIASES.killTerminal,
        (params) => terminal.killTerminal(params as AcpKillTerminalRequest),
      );
      subscribeRequest(
        ACP_SERVER_REQUEST_ALIASES.releaseTerminal,
        (params) => terminal.releaseTerminal(params as AcpReleaseTerminalRequest),
      );
    }
  }

  private async dispatchSessionNotification(notification: AcpSessionNotification): Promise<void> {
    if (this.options.delegate?.onSessionNotification) {
      await this.options.delegate.onSessionNotification(notification);
    }

    for (const listener of this.sessionNotificationListeners) {
      await listener(notification);
    }
  }

  // -32601 (Method not found) is the only error we absorb; agents that advertise legacy
  // method names only reject unknown candidates with it, so every other code is real.
  private async requestWithFallback<T>(
    logicalMethod: AcpLogicalMethod,
    params?: unknown,
    requestOptions?: JsonRpcRequestOptions,
  ): Promise<T> {
    const cachedMethod = this.methodCache.get(logicalMethod);
    if (cachedMethod) {
      return this.options.transport.request<T>(cachedMethod, params, requestOptions);
    }

    const candidates = getAcpMethodCandidates(logicalMethod, this.options.methodOverrides);
    let lastError: Error | null = null;

    for (const methodName of candidates) {
      try {
        const result = await this.options.transport.request<T>(methodName, params, requestOptions);
        this.methodCache.set(logicalMethod, methodName);
        return result;
      } catch (error) {
        if (!(error instanceof JsonRpcErrorResponse) || error.code !== -32601) {
          throw error;
        }
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(`No ACP method candidates configured for ${logicalMethod}`);
  }

  private notifyLogicalMethod(
    logicalMethod: AcpLogicalMethod,
    params?: unknown,
    options: { sendAllCandidatesIfUncached?: boolean } = {},
  ): void {
    const cachedMethod = this.methodCache.get(logicalMethod);
    if (cachedMethod) {
      this.options.transport.notify(cachedMethod, params);
      return;
    }

    // Notifications get no response, so we cannot probe. Fan out to every candidate
    // when the caller explicitly opts in (e.g. cancel, which must reach the agent).
    const candidates = getAcpMethodCandidates(logicalMethod, this.options.methodOverrides);
    const methodNames = options.sendAllCandidatesIfUncached
      ? Array.from(new Set(candidates))
      : candidates.slice(0, 1);

    for (const methodName of methodNames) {
      this.options.transport.notify(methodName, params);
    }
  }
}

function mergeCapabilities(
  base: AcpClientCapabilities | undefined,
  override: AcpClientCapabilities | undefined,
): AcpClientCapabilities | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: AcpClientCapabilities = { ...base, ...override };

  if (base?.auth || override?.auth) {
    merged.auth = { ...base?.auth, ...override?.auth };
  }
  if (base?.fs || override?.fs) {
    merged.fs = { ...base?.fs, ...override?.fs };
  }

  return Object.keys(merged).length === 0 ? undefined : merged;
}
