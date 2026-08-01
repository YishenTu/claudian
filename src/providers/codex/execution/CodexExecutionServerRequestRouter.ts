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
        return this.handleCommandApproval(
          requestId,
          params as CommandApprovalRequest,
        );
      case 'item/fileChange/requestApproval':
        return this.handleFileChangeApproval(
          requestId,
          params as FileChangeApprovalRequest,
        );
      case 'item/permissions/requestApproval':
        return this.handlePermissionsApproval(
          requestId,
          params as PermissionsApprovalRequest,
        );
      case 'item/tool/requestUserInput':
        return this.handleUserInputRequest(
          requestId,
          params as UserInputRequest,
        );
      case 'item/tool/call':
        return this.handleDynamicToolCall(params as DynamicToolCallParams);
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
    this.removePending(pending);
    return true;
  }

  abortAll(reason: ProviderInteractionDismissReason): void {
    for (const pending of [...this.pendingByLocalId.values()]) {
      this.interactionPort.dismissInteraction(pending.interactionId, reason);
      pending.controller.abort();
      this.removePending(pending);
    }
    this.activeTurn = null;
  }

  private async handleDynamicToolCall(
    params: DynamicToolCallParams,
  ): Promise<DynamicToolCallResponse> {
    const turn = this.requireActiveTurn(params.threadId, params.turnId);
    if (!this.dynamicToolRegistry || !isDynamicToolAllowed(turn.toolPolicy, params)) {
      throw new Error(`Unsupported dynamic tool: ${qualifiedToolName(params)}`);
    }
    return this.dynamicToolRegistry.execute(params);
  }

  private async handleCommandApproval(
    requestId: RequestId,
    params: CommandApprovalRequest,
  ): Promise<CommandExecutionApprovalResponse> {
    const turn = this.requireActiveTurn(params.threadId, params.turnId);
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
    const pending = this.createPending(requestId, params.threadId);
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
      this.removePending(pending);
    }
  }

  private async handleFileChangeApproval(
    requestId: RequestId,
    params: FileChangeApprovalRequest,
  ): Promise<FileChangeApprovalResponse> {
    const turn = this.requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { decision: 'decline' };
    }

    const pending = this.createPending(requestId, params.threadId);
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
      this.removePending(pending);
    }
  }

  private async handlePermissionsApproval(
    requestId: RequestId,
    params: PermissionsApprovalRequest,
  ): Promise<PermissionsApprovalResponse> {
    const turn = this.requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { permissions: {}, scope: 'turn' };
    }

    const pending = this.createPending(requestId, params.threadId);
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
      this.removePending(pending);
    }
  }

  private async handleUserInputRequest(
    requestId: RequestId,
    params: UserInputRequest,
  ): Promise<UserInputResponse> {
    const turn = this.requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { answers: {} };
    }
    const pending = this.createPending(requestId, params.threadId);
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
      this.removePending(pending);
    }
  }

  private requireActiveTurn(
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

  private createPending(
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

  private removePending(pending: PendingInteraction): void {
    if (this.pendingByNativeKey.get(pending.nativeKey) === pending) {
      this.pendingByNativeKey.delete(pending.nativeKey);
    }
    if (this.pendingByLocalId.get(pending.interactionId) === pending) {
      this.pendingByLocalId.delete(pending.interactionId);
    }
  }
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
