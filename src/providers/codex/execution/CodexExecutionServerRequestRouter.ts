import type {
  ProviderApprovalDecisionOption,
  ProviderInteractionDismissReason,
  ProviderInteractionPort,
  ProviderToolPolicy,
} from '../../../core/execution';
import type { ApprovalDecision } from '../../../core/types';
import { normalizeCodexToolName } from '../normalization/codexToolNormalization';
import type {
  CommandApprovalRequest,
  CommandExecutionApprovalDecision,
  CommandExecutionApprovalResponse,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeApprovalDecision,
  FileChangeApprovalRequest,
  FileChangeApprovalResponse,
  MCPElicitationRequest,
  MCPElicitationResponse,
  PermissionsApprovalRequest,
  PermissionsApprovalResponse,
  RequestId,
  UserInputRequest,
  UserInputResponse,
} from '../runtime/codexAppServerTypes';
import type { CodexDynamicToolRegistry } from '../runtime/CodexDynamicToolRegistry';

interface ActiveInteractionTurn {
  readonly localTurnId: string;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly toolPolicy: ProviderToolPolicy;
}

interface PendingInteraction {
  readonly interactionId: string;
  readonly nativeKey: string;
  readonly controller: AbortController;
}

type NativeTurnObserver = (threadId: string, turnId: string) => boolean;

export class CodexExecutionServerRequestRouter {
  private activeTurn: ActiveInteractionTurn | null = null;
  private dynamicToolRegistry: CodexDynamicToolRegistry | null = null;
  private interactionCounter = 0;
  private readonly pendingByNativeKey = new Map<string, PendingInteraction>();
  private readonly pendingByLocalId = new Map<string, PendingInteraction>();

  constructor(
    private readonly sessionInstanceId: string,
    private readonly interactionPort: ProviderInteractionPort,
    private readonly observeNativeTurn: NativeTurnObserver,
  ) {}

  setActiveTurn(turn: ActiveInteractionTurn | null): void {
    this.activeTurn = turn;
  }

  setDynamicToolRegistry(registry: CodexDynamicToolRegistry | null): void {
    this.dynamicToolRegistry = registry;
  }

  async handleServerRequest(
    requestId: RequestId,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.#handleCommandApproval(
          requestId,
          params as CommandApprovalRequest,
        );
      case 'item/fileChange/requestApproval':
        return this.#handleFileChangeApproval(
          requestId,
          params as FileChangeApprovalRequest,
        );
      case 'item/permissions/requestApproval':
        return this.#handlePermissionsApproval(
          requestId,
          params as PermissionsApprovalRequest,
        );
      case 'item/tool/requestUserInput':
        return this.#handleUserInputRequest(
          requestId,
          params as UserInputRequest,
        );
      case 'mcpServer/elicitation/request':
        return this.#handleMcpElicitation(requestId, params);
      case 'item/tool/call':
        return this.#handleDynamicToolCall(params as DynamicToolCallParams);
      default:
        throw new Error(`Unsupported server request: ${method}`);
    }
  }

  resolveNativeRequest(
    requestId: RequestId,
    threadId: string,
  ): boolean {
    const pending = this.pendingByNativeKey.get(nativeRequestKey(threadId, requestId));
    if (!pending) return false;

    this.interactionPort.dismissInteraction(pending.interactionId, 'resolved');
    pending.controller.abort();
    this.#removePending(pending);
    return true;
  }

  abortAll(reason: ProviderInteractionDismissReason): void {
    for (const pending of [...this.pendingByLocalId.values()]) {
      this.interactionPort.dismissInteraction(pending.interactionId, reason);
      pending.controller.abort();
      this.#removePending(pending);
    }
    this.activeTurn = null;
  }

  async #handleDynamicToolCall(
    params: DynamicToolCallParams,
  ): Promise<DynamicToolCallResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (!this.dynamicToolRegistry || !isDynamicToolAllowed(turn.toolPolicy, params)) {
      throw new Error(`Unsupported dynamic tool: ${qualifiedToolName(params)}`);
    }
    return this.dynamicToolRegistry.execute(params);
  }

  async #handleCommandApproval(
    requestId: RequestId,
    params: CommandApprovalRequest,
  ): Promise<CommandExecutionApprovalResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { decision: 'decline' };
    }

    const input = {
      command: params.command ?? '',
      cwd: params.cwd ?? null,
      reason: params.reason ?? null,
      commandActions: params.commandActions ?? null,
      approvalId: params.approvalId ?? null,
      networkApprovalContext: params.networkApprovalContext ?? null,
      additionalPermissions: params.additionalPermissions ?? null,
      skillMetadata: params.skillMetadata ?? null,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment ?? null,
      proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments ?? null,
    };
    const pending = this.#createPending(requestId, params.threadId);
    try {
      const response = await this.interactionPort.requestApproval({
        interactionId: pending.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'approval',
        toolName: normalizeCodexToolName('command_execution'),
        input,
        description: describeCommandApproval(params),
        ...(params.reason ? { decisionReason: params.reason } : {}),
        ...(params.additionalPermissions
          ? { additionalPermissions: params.additionalPermissions }
          : {}),
        decisionOptions: buildCommandApprovalDecisionOptions(params),
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          itemId: params.itemId,
        },
      }, pending.controller.signal);
      return {
        decision: response.interactionId === pending.interactionId
          ? mapCommandApprovalDecision(response.decision)
          : 'decline',
      };
    } finally {
      this.#removePending(pending);
    }
  }

  async #handleFileChangeApproval(
    requestId: RequestId,
    params: FileChangeApprovalRequest,
  ): Promise<FileChangeApprovalResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { decision: 'decline' };
    }

    const pending = this.#createPending(requestId, params.threadId);
    try {
      const response = await this.interactionPort.requestApproval({
        interactionId: pending.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'approval',
        toolName: normalizeCodexToolName('file_change'),
        input: {
          reason: params.reason ?? null,
          grantRoot: params.grantRoot ?? null,
        },
        description: params.reason ? `File change: ${params.reason}` : 'File change',
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          itemId: params.itemId,
        },
      }, pending.controller.signal);
      return {
        decision: response.interactionId === pending.interactionId
          ? mapFileChangeApprovalDecision(response.decision)
          : 'decline',
      };
    } finally {
      this.#removePending(pending);
    }
  }

  async #handlePermissionsApproval(
    requestId: RequestId,
    params: PermissionsApprovalRequest,
  ): Promise<PermissionsApprovalResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { permissions: {}, scope: 'turn' };
    }

    const pending = this.#createPending(requestId, params.threadId);
    try {
      const response = await this.interactionPort.requestApproval({
        interactionId: pending.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'approval',
        toolName: 'permissions',
        input: params.permissions as Readonly<Record<string, unknown>>,
        description: params.reason
          ? `Permission request: ${params.reason}`
          : 'Permission request',
        ...(params.reason ? { decisionReason: params.reason } : {}),
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          itemId: params.itemId,
        },
      }, pending.controller.signal);
      if (response.interactionId !== pending.interactionId) {
        return { permissions: {}, scope: 'turn' };
      }
      if (response.decision === 'allow') {
        return { permissions: params.permissions, scope: 'turn' };
      }
      if (response.decision === 'allow-always') {
        return { permissions: params.permissions, scope: 'session' };
      }
      return { permissions: {}, scope: 'turn' };
    } finally {
      this.#removePending(pending);
    }
  }

  async #handleUserInputRequest(
    requestId: RequestId,
    params: UserInputRequest,
  ): Promise<UserInputResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { answers: {} };
    }
    const pending = this.#createPending(requestId, params.threadId);
    try {
      const response = await this.interactionPort.askUserQuestion({
        interactionId: pending.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'question',
        input: { questions: params.questions ?? [] },
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          itemId: params.itemId,
        },
      }, pending.controller.signal);
      if (
        response.interactionId !== pending.interactionId
        || response.answers === null
      ) {
        return { answers: {} };
      }

      const answers: UserInputResponse['answers'] = {};
      for (const [key, value] of Object.entries(response.answers)) {
        answers[key] = {
          answers: (Array.isArray(value) ? value : [value])
            .map(answer => String(answer))
            .filter(answer => answer.trim().length > 0),
        };
      }
      return { answers };
    } finally {
      this.#removePending(pending);
    }
  }

  async #handleMcpElicitation(
    requestId: RequestId,
    params: unknown,
  ): Promise<MCPElicitationResponse> {
    if (!isMCPElicitationRequest(params) || params.turnId === null) {
      return { action: 'cancel', content: null };
    }
    if (
      params.mode === 'url'
      || !isEmptyConfirmationSchema(params.requestedSchema)
    ) {
      return { action: 'decline', content: null };
    }

    let pending: PendingInteraction | undefined;
    try {
      const turn = this.#requireActiveTurn(params.threadId, params.turnId);
      if (!shouldRouteApproval(turn.toolPolicy)) {
        return { action: 'decline', content: null };
      }
      pending = this.#createPending(requestId, params.threadId);
      const response = await this.interactionPort.askUserQuestion({
        interactionId: pending.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'question',
        input: {
          questions: [{
            id: MCP_CONFIRMATION_QUESTION_ID,
            header: 'MCP request',
            question: `MCP server: ${params.serverName}\n\n${params.message}`,
            options: [
              { label: 'Cancel', description: 'Cancel this request.', value: 'cancel' },
              { label: 'Decline', description: 'Decline this request.', value: 'decline' },
              { label: 'Allow', description: 'Accept this request.', value: 'accept' },
            ],
            multiSelect: false,
            isOther: false,
            isSecret: false,
          }],
        },
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          serverName: params.serverName,
        },
      }, pending.controller.signal);
      if (
        pending.controller.signal.aborted
        || this.activeTurn !== turn
        || this.pendingByLocalId.get(pending.interactionId) !== pending
        || response.interactionId !== pending.interactionId
        || !isPlainRecord(response.answers)
        || Object.keys(response.answers).length !== 1
      ) {
        return { action: 'cancel', content: null };
      }
      const answer = response.answers[MCP_CONFIRMATION_QUESTION_ID];
      if (answer === 'accept') return { action: 'accept', content: {} };
      if (answer === 'decline') return { action: 'decline', content: null };
      return { action: 'cancel', content: null };
    } catch {
      // Stale, aborted, and failed interactions must not grant MCP access.
      return { action: 'cancel', content: null };
    } finally {
      if (pending) this.#removePending(pending);
    }
  }

  #requireActiveTurn(
    threadId: string,
    nativeTurnId: string,
  ): ActiveInteractionTurn {
    if (!this.observeNativeTurn(threadId, nativeTurnId)) {
      throw new Error('Stale Codex server request');
    }

    const turn = this.activeTurn;
    if (
      !turn
      || turn.nativeThreadId !== threadId
      || turn.nativeTurnId !== nativeTurnId
    ) {
      throw new Error('Stale Codex server request');
    }
    return turn;
  }

  #createPending(
    requestId: RequestId,
    threadId: string,
  ): PendingInteraction {
    const interactionId =
      `${this.sessionInstanceId}:interaction:${++this.interactionCounter}`;
    const nativeKey = nativeRequestKey(threadId, requestId);
    const existing = this.pendingByNativeKey.get(nativeKey);
    if (existing) {
      throw new Error('Duplicate Codex server request');
    }

    const pending = {
      interactionId,
      nativeKey,
      controller: new AbortController(),
    };
    this.pendingByNativeKey.set(nativeKey, pending);
    this.pendingByLocalId.set(interactionId, pending);
    return pending;
  }

  #removePending(pending: PendingInteraction): void {
    if (this.pendingByNativeKey.get(pending.nativeKey) === pending) {
      this.pendingByNativeKey.delete(pending.nativeKey);
    }
    if (this.pendingByLocalId.get(pending.interactionId) === pending) {
      this.pendingByLocalId.delete(pending.interactionId);
    }
  }
}

const MCP_CONFIRMATION_QUESTION_ID = 'mcp-elicitation-confirmation';
const EMPTY_CONFIRMATION_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMCPElicitationRequest(value: unknown): value is MCPElicitationRequest {
  return isPlainRecord(value)
    && typeof value.threadId === 'string' && value.threadId.length > 0
    && (value.turnId === null || (typeof value.turnId === 'string' && value.turnId.length > 0))
    && typeof value.serverName === 'string' && value.serverName.trim().length > 0
    && typeof value.message === 'string'
    && (value.mode === 'form' || value.mode === 'openai/form' || value.mode === 'url');
}

function isEmptyConfirmationSchema(value: unknown): boolean {
  return isPlainRecord(value)
    && Object.keys(value).every(key => EMPTY_CONFIRMATION_SCHEMA_KEYS.has(key))
    && value.type === 'object'
    && isPlainRecord(value.properties)
    && Object.keys(value.properties).length === 0
    && (!('required' in value) || (Array.isArray(value.required) && value.required.length === 0))
    && (!('additionalProperties' in value) || typeof value.additionalProperties === 'boolean');
}

function nativeRequestKey(threadId: string, requestId: RequestId): string {
  return `${threadId}\u0000${String(requestId)}`;
}

function qualifiedToolName(params: DynamicToolCallParams): string {
  return params.namespace ? `${params.namespace}.${params.tool}` : params.tool;
}

function shouldRouteApproval(policy: ProviderToolPolicy): boolean {
  return policy.kind === 'provider-default' || policy.kind === 'unrestricted';
}

function isDynamicToolAllowed(
  policy: ProviderToolPolicy,
  params: DynamicToolCallParams,
): boolean {
  if (policy.kind === 'provider-default' || policy.kind === 'unrestricted') {
    return true;
  }
  if (policy.kind !== 'allow-list') return false;
  const qualifiedName = qualifiedToolName(params);
  return policy.names.includes(params.tool) || policy.names.includes(qualifiedName);
}

function describeCommandApproval(params: CommandApprovalRequest): string {
  if (params.networkApprovalContext) {
    return `Allow ${params.networkApprovalContext.protocol} access to ${params.networkApprovalContext.host}`;
  }
  return params.command ? `Execute: ${params.command}` : 'Execute command';
}

function buildCommandApprovalDecisionOptions(
  params: CommandApprovalRequest,
): ProviderApprovalDecisionOption[] {
  const available = params.availableDecisions
    ?? ['accept', 'acceptForSession', 'decline'];
  return available.map(decision => mapDecisionOption(decision, params));
}

function mapDecisionOption(
  decision: CommandExecutionApprovalDecision,
  params: CommandApprovalRequest,
): ProviderApprovalDecisionOption {
  if (decision === 'accept') {
    return { label: 'Allow once', value: 'allow-once', decision: 'allow' };
  }
  if (decision === 'acceptForSession') {
    return {
      label: 'Always allow',
      value: 'allow-always',
      decision: 'allow-always',
    };
  }
  if (decision === 'decline') {
    return { label: 'Deny', value: 'deny', decision: 'deny' };
  }
  if (decision === 'cancel') {
    return { label: 'Cancel', value: 'cancel', decision: 'cancel' };
  }
  if ('acceptWithExecpolicyAmendment' in decision) {
    return {
      label: 'Allow similar commands',
      description: 'Approve and store an exec policy amendment.',
      value: JSON.stringify(decision),
    };
  }

  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  const host = amendment.host || params.networkApprovalContext?.host || 'host';
  return {
    label: `${amendment.action === 'deny' ? 'Deny' : 'Allow'} ${host} for this session`,
    description: `Apply a ${amendment.action} rule for ${host}.`,
    value: JSON.stringify(decision),
  };
}

function mapCommandApprovalDecision(
  decision: ApprovalDecision,
): CommandExecutionApprovalDecision {
  if (decision === 'allow') return 'accept';
  if (decision === 'allow-always') return 'acceptForSession';
  if (decision === 'cancel') return 'cancel';
  if (
    typeof decision === 'object'
    && decision !== null
    && decision.type === 'select-option'
  ) {
    try {
      return JSON.parse(decision.value) as CommandExecutionApprovalDecision;
    } catch {
      return 'decline';
    }
  }
  return 'decline';
}

function mapFileChangeApprovalDecision(
  decision: ApprovalDecision,
): FileChangeApprovalDecision {
  if (decision === 'allow') return 'accept';
  if (decision === 'allow-always') return 'acceptForSession';
  if (decision === 'cancel') return 'cancel';
  return 'decline';
}
