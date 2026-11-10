import type { ACPJSONRPCTransport, JSONRPCRequestOptions } from './ACPJSONRPCTransport';
import {
  ACP_METHOD_NAMES,
  ACP_SERVER_NOTIFICATION_METHODS,
  ACP_SERVER_REQUEST_METHODS,
  type ACPLogicalMethod,
} from './methodNames';
import type {
  ACPCancelNotification,
  ACPClientCapabilities,
  ACPCloseSessionRequest,
  ACPCloseSessionResponse,
  ACPCreateElicitationRequest,
  ACPCreateElicitationResponse,
  ACPImplementation,
  ACPInitializeRequest,
  ACPInitializeResponse,
  ACPLoadSessionRequest,
  ACPLoadSessionResponse,
  ACPNewSessionRequest,
  ACPNewSessionResponse,
  ACPPromptRequest,
  ACPPromptResponse,
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
  ACPResumeSessionRequest,
  ACPResumeSessionResponse,
  ACPSessionNotification,
  ACPSetSessionConfigOptionRequest,
  ACPSetSessionConfigOptionResponse,
  ACPSetSessionModelRequest,
  ACPSetSessionModelResponse,
  ACPSetSessionModeRequest,
  ACPSetSessionModeResponse,
} from './types';
import { ACP_PROTOCOL_VERSION } from './types';

type SessionNotificationListener = (
  notification: ACPSessionNotification,
) => void | Promise<void>;

// ACP prompt turns are long-running RPCs; session/update notifications stream progress until the final response.
const ACP_PROMPT_TURN_TIMEOUT_MS = 0;

export interface ACPClientConnectionDelegate {
  /** Registered only when present; advertise `elicitation` in client capabilities to receive requests. */
  createElicitation?: (
    request: ACPCreateElicitationRequest,
  ) => Promise<ACPCreateElicitationResponse>;
  onSessionNotification?: SessionNotificationListener;
  requestPermission?: (
    request: ACPRequestPermissionRequest,
  ) => Promise<ACPRequestPermissionResponse>;
}

export interface ACPClientConnectionOptions {
  clientCapabilities?: ACPClientCapabilities;
  clientInfo?: ACPImplementation | null;
  delegate?: ACPClientConnectionDelegate;
  transport: ACPJSONRPCTransport;
}

export class ACPClientConnection {
  private readonly unsubscribeHandlers: Array<() => void> = [];

  constructor(private readonly options: ACPClientConnectionOptions) {
    this.#registerServerHandlers();
  }

  dispose(): void {
    while (this.unsubscribeHandlers.length > 0) {
      this.unsubscribeHandlers.pop()?.();
    }
  }

  initialize(): Promise<ACPInitializeResponse> {
    return this.#request<ACPInitializeResponse>('initialize', {
      ...(this.options.clientCapabilities ? { clientCapabilities: this.options.clientCapabilities } : {}),
      clientInfo: this.options.clientInfo ?? null,
      protocolVersion: ACP_PROTOCOL_VERSION,
    } satisfies ACPInitializeRequest);
  }

  newSession(request: ACPNewSessionRequest): Promise<ACPNewSessionResponse> {
    return this.#request<ACPNewSessionResponse>('newSession', request);
  }

  loadSession(request: ACPLoadSessionRequest): Promise<ACPLoadSessionResponse> {
    return this.#request<ACPLoadSessionResponse>('loadSession', request);
  }

  resumeSession(request: ACPResumeSessionRequest): Promise<ACPResumeSessionResponse> {
    return this.#request<ACPResumeSessionResponse>('resumeSession', request);
  }

  closeSession(request: ACPCloseSessionRequest): Promise<ACPCloseSessionResponse> {
    return this.#request<ACPCloseSessionResponse>('closeSession', request);
  }

  setConfigOption(request: ACPSetSessionConfigOptionRequest): Promise<ACPSetSessionConfigOptionResponse> {
    return this.#request<ACPSetSessionConfigOptionResponse>('setConfigOption', request);
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

    if (delegate?.createElicitation) {
      const createElicitation = delegate.createElicitation;
      subscribeRequest(
        ACP_SERVER_REQUEST_METHODS.createElicitation,
        (params) => createElicitation(params as ACPCreateElicitationRequest),
      );
    }
  }

  async #dispatchSessionNotification(notification: ACPSessionNotification): Promise<void> {
    await this.options.delegate?.onSessionNotification?.(notification);
  }

  #request<T>(
    logicalMethod: ACPLogicalMethod,
    params?: unknown,
    requestOptions?: JSONRPCRequestOptions,
  ): Promise<T> {
    return this.options.transport.request<T>(ACP_METHOD_NAMES[logicalMethod], params, requestOptions);
  }
}
